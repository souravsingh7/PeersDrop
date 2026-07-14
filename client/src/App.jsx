import { useRef, useState } from "react";
import Peer from "peerjs";

import "./App.css";

const CHUNK_SIZE = 64 * 1024; // 64 KB — safe across Chrome & Firefox, no DataChannel fragmentation

const METERED_API_KEY = import.meta.env.VITE_METERED_API_KEY;

// First-attempt ICE config: STUN only — no TURN.
// This lets the browser try host (LAN) and srflx (public IP via STUN) candidates first.
// TURN relay is only used as a fallback (via the Metered API) if both of those fail.
// The old openrelay.metered.ca static TURN credentials were unreliable and caused ICE
// to report "failed", which incorrectly triggered the paid Metered TURN fallback.
const STUN_ONLY_CONFIG = {
    iceTransportPolicy: "all",
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
    ]
};

// Returns STUN-only config for the first connection attempt.
// Pass useApi=true to fetch Metered TURN credentials as a fallback.
const fetchIceConfig = async (useApi = false) => {
    if (!useApi || !METERED_API_KEY) {
        console.log(useApi && !METERED_API_KEY
            ? "Metered API key missing — no TURN fallback available. Using STUN only."
            : "Using STUN-only config (host + srflx candidates, no relay cost).");
        return STUN_ONLY_CONFIG;
    }

    console.log("Fetching Metered TURN credentials as fallback...");

    try {
        const url = `https://peersdrop.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;

        const resp = await fetch(url, {
            signal: AbortSignal.timeout(6000)
        });

        console.log("Metered credentials API status:", resp.status);

        if (!resp.ok) {
            const text = await resp.text();
            console.error("Metered API failed:", text);
            throw new Error(`Metered API bad response: ${resp.status}`);
        }

        const iceServers = await resp.json();

        console.log("Metered ICE servers received:", iceServers);

        return {
            iceTransportPolicy: "all",
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                ...iceServers
            ]
        };
    } catch (err) {
        console.error("Failed to fetch Metered TURN credentials. Falling back to STUN only.", err);
        return STUN_ONLY_CONFIG;
    }
};

const generateRoomId = () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
};


export default function App() {
    const [roomId, setRoomId] = useState("");
    const [joinInput, setJoinInput] = useState("");
    const [mode, setMode] = useState(null); // "create" | "join"
    const [joined, setJoined] = useState(false);
    const [status, setStatus] = useState("Not connected");
    const [selectedFile, setSelectedFile] = useState(null);
    const [sendProgress, setSendProgress] = useState(0);
    const [receiveProgress, setReceiveProgress] = useState(0);
    const [receivedFile, setReceivedFile] = useState(null); // { url, name }
    const [channelOpen, setChannelOpen] = useState(false);
    const [logs, setLogs] = useState([]);

    const [copied, setCopied] = useState(false);
    const [isDragging, setIsDragging] = useState(false);

    const peerRef = useRef(null);
    const connRef = useRef(null);
    const connTimeoutRef = useRef(null);

    const receiveMetaRef = useRef(null);
    const receivedChunksRef = useRef([]);
    const receivedSizeRef = useRef(0);
    const lastReceiveProgressRef = useRef(0);

    const addLog = (message) => {
        setLogs((prev) => [`${new Date().toLocaleTimeString()} - ${message}`, ...prev]);
    };

    const setupConnection = (conn, onIceFailed) => {
        if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);

        const onOpen = () => {
            clearTimeout(connTimeoutRef.current);
            setChannelOpen(true);
            setStatus("Connected. Ready to send files.");
            addLog("P2P connection established");
        };

        // Race condition fix: conn may already be open by the time we attach listener
        if (conn.open) {
            onOpen();
        } else {
            connTimeoutRef.current = setTimeout(() => {
                setStatus("Connection timed out. Check your network and try again.");
            }, 30000);
            conn.on("open", onOpen);
        }

        conn.on("data", handleData);

        conn.on("close", () => {
            clearTimeout(connTimeoutRef.current);
            setChannelOpen(false);
            setStatus("Peer disconnected");
            addLog("Peer left");
        });

        conn.on("error", (err) => {
            clearTimeout(connTimeoutRef.current);
            setStatus("Connection error. Please try again.");
            addLog(`Connection error: ${err.message}`);
        });

        // Monitor ICE negotiation — attach via addEventListener to avoid clobbering PeerJS internals
        setTimeout(() => {
            const pc = conn.peerConnection;
            if (!pc) {
                addLog("[ICE] PeerConnection not accessible yet — monitor skipped");
                return;
            }

            addLog(`[ICE] Policy: ${pc.getConfiguration?.()?.iceTransportPolicy ?? "all (default)"}`);

            // ── Candidate gathering ──────────────────────────────────────────
            pc.addEventListener("icecandidate", (event) => {
                if (!event.candidate) {
                    addLog("[ICE] Gathering complete — all candidates sent to peer");
                    return;
                }
                const c = event.candidate;
                const type = c.type || "unknown";
                const proto = c.protocol || "?";
                const addr = c.address || "(hidden)";
                const icon = type === "host" ? "🏠 host" : type === "srflx" ? "🌐 srflx (STUN)" : type === "relay" ? "🔁 relay (TURN)" : `❓ ${type}`;
                addLog(`[ICE] Candidate: ${icon} | ${proto} | ${addr}`);
            });

            pc.addEventListener("icecandidateerror", (event) => {
                addLog(`[ICE] ❌ Candidate error [${event.errorCode}]: ${event.errorText} — ${event.url}`);
            });

            // ── Gathering state ──────────────────────────────────────────────
            pc.addEventListener("icegatheringstatechange", () => {
                addLog(`[ICE] Gathering state → ${pc.iceGatheringState}`);
            });

            // ── Connection state ─────────────────────────────────────────────
            pc.addEventListener("iceconnectionstatechange", () => {
                const s = pc.iceConnectionState;
                addLog(`[ICE] Connection state → ${s}`);

                if (s === "checking") {
                    addLog("[ICE] Trying candidate pairs (host → srflx → relay)...");
                }

                if (s === "connected" || s === "completed") {
                    clearTimeout(connTimeoutRef.current);
                    // Log which candidate pair actually won
                    pc.getStats().then((stats) => {
                        stats.forEach((report) => {
                            if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") {
                                const local = stats.get(report.localCandidateId);
                                const remote = stats.get(report.remoteCandidateId);
                                if (local && remote) {
                                    addLog(
                                        `[ICE] ✅ Path selected: local=${local.candidateType}(${local.protocol}) ↔ remote=${remote.candidateType}(${remote.protocol})`
                                    );
                                    const costNote = local.candidateType === "relay" || remote.candidateType === "relay"
                                        ? "⚠ TURN relay is being used — STUN/host paths were unreachable"
                                        : "👍 Direct path (no TURN relay cost)";
                                    addLog(`[ICE] ${costNote}`);
                                }
                            }
                        });
                    }).catch(() => { });
                }

                if (s === "failed") {
                    clearTimeout(connTimeoutRef.current);
                    if (onIceFailed) {
                        addLog("[ICE] ❌ All STUN/host paths failed — falling back to API TURN server...");
                        setStatus("Retrying with TURN server...");
                        onIceFailed();
                    } else {
                        addLog("[ICE] ❌ All paths exhausted (host + srflx + relay). Check firewall/network.");
                        setStatus("ICE connection failed. Network may be blocking P2P. Try a different network.");
                    }
                }

                if (s === "disconnected") {
                    addLog("[ICE] ⚠ Connection dropped — browser may attempt ICE restart");
                }
            });
        }, 500);
    };

    const copyRoomId = () => {
        navigator.clipboard.writeText(roomId).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const createRoom = async (retryId, useApiIce = false) => {
        const newId = typeof retryId === "string" ? retryId : generateRoomId();
        setMode("create");
        setStatus(useApiIce ? "Fetching TURN credentials..." : "Connecting...");

        const iceConfig = await fetchIceConfig(useApiIce);

        const peer = new Peer(newId, { config: iceConfig });
        peerRef.current = peer;

        peer.on("open", (id) => {
            setRoomId(id);
            setJoined(true);
            setStatus("Waiting for peer...");
            addLog(`Room created: ${id}`);
        });

        peer.on("connection", (conn) => {
            connRef.current = conn;
            const onIceFailed = (!useApiIce && METERED_API_KEY)
                ? () => { peer.destroy(); createRoom(newId, true); }
                : null;
            setupConnection(conn, onIceFailed);
            addLog("Peer connected to room");
            setStatus("Peer found, connecting...");
        });

        peer.on("error", (err) => {
            addLog(`Error: ${err.type} — ${err.message}`);
            if (err.type === "unavailable-id") {
                // Auto-retry with a fresh code on collision
                peer.destroy();
                createRoom();
            } else {
                setStatus(`Error: ${err.message}`);
            }
        });
    };

    const joinRoom = async (useApiIce = false, turnRetryCount = 0) => {
        const id = joinInput.trim().toLowerCase();
        if (!id) {
            alert("Please enter a room ID");
            return;
        }

        setStatus(useApiIce ? "Fetching TURN credentials..." : "Connecting...");
        const iceConfig = await fetchIceConfig(useApiIce);

        const peer = new Peer(undefined, { config: iceConfig });
        peerRef.current = peer;
        setMode("join");

        peer.on("open", () => {
            setRoomId(id);
            setJoined(true);
            setStatus("Connecting to peer...");
            addLog(`Connecting to room: ${id}`);

            const conn = peer.connect(id, { reliable: true });
            connRef.current = conn;
            const onIceFailed = (!useApiIce && METERED_API_KEY)
                ? () => { peer.destroy(); joinRoom(true, 0); }
                : null;
            setupConnection(conn, onIceFailed);
        });

        peer.on("error", (err) => {
            addLog(`Error: ${err.message}`);
            if (err.type === "peer-unavailable") {
                if (useApiIce && turnRetryCount < 4) {
                    // Creator is also restarting their peer with TURN at the same time.
                    // Wait and retry — creator's new room will be ready shortly.
                    const delay = (turnRetryCount + 1) * 2000; // 2s, 4s, 6s, 8s
                    addLog(`[ICE] Creator room not ready yet — retrying in ${delay / 1000}s (attempt ${turnRetryCount + 1}/4)...`);
                    setStatus(`Waiting for creator to reconnect... (${turnRetryCount + 1}/4)`);
                    peer.destroy();
                    setTimeout(() => joinRoom(true, turnRetryCount + 1), delay);
                } else {
                    alert("Room not found. Check the room ID and try again.");
                    disconnect();
                }
            }
        });
    };

    const handleData = (data) => {
        if (typeof data === "string") {
            const message = JSON.parse(data);

            if (message.type === "file-meta") {
                receiveMetaRef.current = message;
                receivedChunksRef.current = [];
                receivedSizeRef.current = 0;
                lastReceiveProgressRef.current = 0;
                setReceiveProgress(0);
                addLog(`Receiving: ${message.name}`);
            }

            if (message.type === "file-complete") {
                const meta = receiveMetaRef.current;
                const blob = new Blob(receivedChunksRef.current, { type: meta.mimeType || "application/octet-stream" });
                const url = URL.createObjectURL(blob);
                setReceivedFile({ url, name: meta.name });
                setReceiveProgress(100);
                addLog(`File ready: ${meta.name}`);
                receiveMetaRef.current = null;
                receivedChunksRef.current = [];
                receivedSizeRef.current = 0;
            }
            return;
        }

        // Binary chunk received — accumulate
        const meta = receiveMetaRef.current;
        if (!meta) return;

        const buffer = data instanceof ArrayBuffer
            ? data
            : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

        receivedChunksRef.current.push(buffer);
        receivedSizeRef.current += buffer.byteLength;
        const pct = Math.round((receivedSizeRef.current / meta.size) * 100);
        if (pct > lastReceiveProgressRef.current) {
            lastReceiveProgressRef.current = pct;
            setReceiveProgress(pct);
        }
    };

    const sendFile = async () => {
        const conn = connRef.current;
        if (!conn || !channelOpen) { alert("Not connected yet"); return; }
        if (!selectedFile) { alert("Please select a file"); return; }

        setSendProgress(0);

        conn.send(JSON.stringify({
            type: "file-meta",
            name: selectedFile.name,
            size: selectedFile.size,
            mimeType: selectedFile.type,
        }));

        const arrayBuffer = await selectedFile.arrayBuffer();

        // Every file is sent in 64 KB chunks with backpressure
        let offset = 0;
        while (offset < arrayBuffer.byteLength) {
            const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
            conn.send(chunk);
            offset += chunk.byteLength;
            setSendProgress(Math.round((offset / arrayBuffer.byteLength) * 100));

            const dc = conn.dataChannel;
            if (dc && dc.bufferedAmount > 1024 * 1024) {
                await new Promise((resolve) => {
                    const check = () => {
                        if (!dc || dc.bufferedAmount < 512 * 1024) resolve();
                        else setTimeout(check, 50);
                    };
                    check();
                });
            }
        }
        conn.send(JSON.stringify({ type: "file-complete" }));

        addLog(`File sent: ${selectedFile.name}`);
    };

    const cleanupPeer = () => {
        clearTimeout(connTimeoutRef.current);
        if (connRef.current) {
            connRef.current.close();
            connRef.current = null;
        }
        if (peerRef.current) {
            peerRef.current.destroy();
            peerRef.current = null;
        }
        setChannelOpen(false);
    };

    const disconnect = () => {
        cleanupPeer();
        setJoined(false);
        setMode(null);
        setRoomId("");
        setJoinInput("");
        setStatus("Not connected");
        setSendProgress(0);
        setReceiveProgress(0);
        setReceivedFile(null);
        addLog("Disconnected");
    };

    // Derive status dot class
    const dotClass =
        channelOpen ? "" :
            status.toLowerCase().includes("waiting") ? "waiting" :
                status.toLowerCase().includes("error") || status.toLowerCase().includes("not found") ? "error" :
                    status.toLowerCase().includes("connecting") ? "waiting" : "idle";

    const statusValueClass = dotClass || "idle";

    return (
        <div className="app">
            <div className="card">

                {/* ── Header ── */}
                <div className="header">
                    <div className="header-left">
                        <div className="brand-icon">
                            <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
                        </div>
                        <div className="header-text">
                            <h1>Share Files Instantly</h1>
                            <p className="subtitle">Secure peer-to-peer file transfer using WebRTC. Fast, private, and simple.</p>
                        </div>
                    </div>
                    <div className="header-illustration">
                        <div className="folder-icon blue">
                            <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                        </div>
                        <div className="transfer-arrow">
                            <span /><span /><span />
                        </div>
                        <div className="folder-icon violet">
                            <svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                        </div>
                    </div>
                </div>

                {/* ── Status Bar ── */}
                <div className={`status-bar ${dotClass}`}>
                    <span className={`status-dot ${dotClass}`} />
                    <span className="status-label">Status:&nbsp;</span>
                    <span className={`status-value ${statusValueClass}`}>{status}</span>
                </div>

                {/* ── Lobby / Share ── */}
                {!joined ? (
                    <div className="lobby">
                        <div className="lobby-option">
                            <div className="option-icon green">
                                <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                            </div>
                            <h3>Create a Room</h3>
                            <p>Generate a room ID and share it with the other person.</p>
                            <button className="btn-green" onClick={() => createRoom()}>Create Room</button>
                        </div>

                        <div className="lobby-divider">
                            <div className="dot-line" />
                            <div className="or-circle">or</div>
                            <div className="dot-line" />
                        </div>

                        <div className="lobby-option">
                            <div className="option-icon blue">
                                <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                            </div>
                            <h3>Join a Room</h3>
                            <p>Enter the room ID shared by the other person.</p>
                            <input
                                value={joinInput}
                                onChange={(e) => setJoinInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && joinRoom()}
                                placeholder="Paste room ID from the other person"
                            />
                            <button className="btn-blue" onClick={() => joinRoom()}>Join Room</button>
                        </div>
                    </div>
                ) : (
                    <div className="share-box">
                        <div className="room-badge">
                            🔗 Room: <span className="badge-id">{roomId}</span>
                            {mode === "create" && (
                                <>
                                    <span className="room-hint">← share this</span>
                                    <button className="copy-btn" onClick={copyRoomId}>
                                        {copied ? "✓ Copied" : "Copy"}
                                    </button>
                                </>
                            )}
                        </div>

                        <label
                            className={`file-input-wrapper${isDragging ? " dragging" : ""}`}
                            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                            onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
                            onDragLeave={() => setIsDragging(false)}
                            onDrop={(e) => {
                                e.preventDefault();
                                setIsDragging(false);
                                const file = e.dataTransfer.files[0];
                                if (file) setSelectedFile(file);
                            }}
                        >
                            <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            <span>{selectedFile ? selectedFile.name : isDragging ? "Drop it!" : "Click or drag a file here"}</span>
                            <input type="file" onChange={(e) => setSelectedFile(e.target.files[0])} />
                        </label>

                        {selectedFile && (
                            <div className="file-info">
                                📄 {selectedFile.name} — {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                            </div>
                        )}

                        <div className="action-row">
                            <button className="btn-blue" onClick={sendFile} disabled={!channelOpen}>
                                Send File
                            </button>
                            <button className="btn-danger" onClick={disconnect}>Disconnect</button>
                        </div>

                        <div className="progress-block">
                            <label>Send Progress: {sendProgress}%</label>
                            <progress value={sendProgress} max="100" />
                        </div>

                        <div className="progress-block">
                            <label>Receive Progress: {receiveProgress}%</label>
                            <progress value={receiveProgress} max="100" />
                        </div>

                        {receivedFile && (
                            <div className="received-file">
                                <span>📄 <strong>{receivedFile.name}</strong> is ready</span>
                                <a
                                    href={receivedFile.url}
                                    download={receivedFile.name}
                                    className="download-btn"
                                    onClick={() => {
                                        setTimeout(() => {
                                            URL.revokeObjectURL(receivedFile.url);
                                            setReceivedFile(null);
                                        }, 1000);
                                    }}
                                >
                                    ⬇ Download
                                </a>
                            </div>
                        )}
                    </div>
                )}

            </div>
            <div className="signature">savy@2026</div>
        </div>
    );
}
