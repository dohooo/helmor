import { createOpenAiRealtimeClientSecret } from "@/lib/api";
import { voiceDiag } from "./voice-diag";

/** Tag session-lifecycle events under the `session.` namespace. */
function diag(event: string, data?: Record<string, unknown>) {
	voiceDiag(`session.${event}`, data);
}

let sessionSeq = 0;

/** Minimal shape of a server-pushed Realtime event. We only narrow the
 *  `type` discriminator -- everything else stays `unknown` so the consumer
 *  can pattern-match without us copying the full event schema. */
export type RealtimeServerEvent = {
	type?: string;
	[key: string]: unknown;
};

type EventListener = (event: RealtimeServerEvent) => void;

/** Client-side event posted back over the WebRTC data channel. Shape is
 *  open-ended for the same reason as RealtimeServerEvent — every caller
 *  pattern-matches against `type` and we don't want to copy the full
 *  event schema. */
export type RealtimeClientEvent = {
	type: string;
	[key: string]: unknown;
};

export type RealtimeVoiceSession = {
	/** Tear down peer + mic + speaker + close audio context. Idempotent. */
	stop: () => void;
	/** Subscribe to dataChannel events. Returns an unsubscribe. Listeners
	 *  registered before the WebRTC handshake completes still get every
	 *  event (including `session.created`) because the listener fan-out
	 *  is wired before `setLocalDescription`. */
	onEvent: (listener: EventListener) => () => void;
	/** Post a client event back to the model over the data channel.
	 *  Used by the tool dispatcher to return `function_call_output`
	 *  items and trigger follow-up responses. No-op (with a console
	 *  warning) if the data channel isn't open yet. */
	send: (event: RealtimeClientEvent) => void;
	/** User's microphone stream. Stable for the whole session lifetime --
	 *  safe to feed straight to an `AnalyserNode`. */
	localStream: MediaStream;
	/** OpenAI's TTS stream. Resolves the first time `ontrack` fires. */
	remoteStream: Promise<MediaStream>;
};

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export async function startRealtimeVoiceSession(): Promise<RealtimeVoiceSession> {
	const sessionId = `voice-${++sessionSeq}`;
	const sessionStart = performance.now();
	diag("start", { sessionId, ...browserDiagState() });

	if (!navigator.mediaDevices?.getUserMedia) {
		diag("abort", { reason: "getUserMedia unavailable" });
		throw new Error(
			"Microphone capture is unavailable in this Tauri WebView. Restart Helmor and try again.",
		);
	}

	// Token mint (Rust → OpenAI HTTPS) and getUserMedia (macOS TCC
	// prompt + first-frame negotiation) are independent and were the
	// two biggest "Connecting" stalls. Running them in parallel cuts
	// the perceived warmup by roughly one network round-trip.
	// `allSettled` so we can stop a hot mic stream if token mint races
	// to reject after mic succeeded — otherwise the yellow mic
	// indicator would linger on a failed session.
	diag("warmup-parallel-start", { tokenMint: true, micRequest: true });
	const tokenStart = performance.now();
	const micStart = performance.now();
	const [tokenResult, micResult] = await Promise.allSettled([
		createOpenAiRealtimeClientSecret().then(
			(v) => {
				diag("token-mint-ok", {
					elapsedMs: Math.round(performance.now() - tokenStart),
					expiresAt: v.expiresAt ?? null,
				});
				return v;
			},
			(err) => {
				diag("token-mint-failed", {
					elapsedMs: Math.round(performance.now() - tokenStart),
					error: messageOf(err),
				});
				throw err;
			},
		),
		getMicrophoneStream().then(
			(v) => {
				diag("mic-ok", {
					elapsedMs: Math.round(performance.now() - micStart),
					trackCount: v.getTracks().length,
				});
				return v;
			},
			(err) => {
				diag("mic-failed", {
					elapsedMs: Math.round(performance.now() - micStart),
					error: messageOf(err),
				});
				throw err;
			},
		),
	]);
	if (tokenResult.status === "rejected") {
		if (micResult.status === "fulfilled") {
			for (const track of micResult.value.getTracks()) track.stop();
			diag("cleanup-orphan-mic", { reason: "token mint failed after mic ok" });
		}
		throw tokenResult.reason;
	}
	if (micResult.status === "rejected") {
		throw micResult.reason;
	}
	const clientSecret = tokenResult.value;
	const stream = micResult.value;
	const peer = new RTCPeerConnection();
	const audio = new Audio();
	const dataChannel = peer.createDataChannel("oai-events");
	diag("peer-created", { sessionId, ...browserDiagState() });

	// Peer-state watchers: the WebRTC handshake silently transitions
	// through ICE / DTLS / connection states. When something hangs
	// ("Connecting" lingers forever), the operator wants to know
	// whether ICE never gathered candidates, the connection failed
	// post-DTLS, or the dataChannel never opened.
	peer.addEventListener("iceconnectionstatechange", () => {
		diag("peer-ice-state", {
			sessionId,
			state: peer.iceConnectionState,
			...browserDiagState(),
		});
	});
	peer.addEventListener("connectionstatechange", () => {
		diag("peer-connection-state", {
			sessionId,
			state: peer.connectionState,
			...browserDiagState(),
		});
	});
	peer.addEventListener("icegatheringstatechange", () => {
		diag("peer-ice-gathering", { state: peer.iceGatheringState });
	});
	peer.addEventListener("signalingstatechange", () => {
		diag("peer-signaling-state", { state: peer.signalingState });
	});

	dataChannel.addEventListener("open", () => {
		diag("datachannel-open", {
			sessionId,
			elapsedMs: Math.round(performance.now() - sessionStart),
			...browserDiagState(),
		});
	});
	dataChannel.addEventListener("close", () => {
		diag("datachannel-close", { sessionId, ...browserDiagState() });
	});
	dataChannel.addEventListener("error", (event) => {
		// `event` is an RTCErrorEvent in spec-compliant impls but Chromium
		// hands back a plain Event; walk both shapes.
		const err = (event as { error?: { message?: string } }).error;
		diag("datachannel-error", {
			sessionId,
			message: err?.message ?? String(event.type ?? "unknown"),
			...browserDiagState(),
		});
	});

	audio.autoplay = true;
	audio.addEventListener("play", () => {
		diag("audio-play", { sessionId, ...audioDiagState(audio) });
	});
	audio.addEventListener("playing", () => {
		diag("audio-playing", { sessionId, ...audioDiagState(audio) });
	});
	audio.addEventListener("pause", () => {
		diag("audio-pause", { sessionId, ...audioDiagState(audio) });
	});
	audio.addEventListener("error", () => {
		diag("audio-error", {
			sessionId,
			error: audio.error?.message ?? null,
			code: audio.error?.code ?? null,
			...audioDiagState(audio),
		});
	});

	let resolveRemote!: (s: MediaStream) => void;
	const remoteStream = new Promise<MediaStream>((resolve) => {
		resolveRemote = resolve;
	});

	peer.ontrack = (event) => {
		const [remote] = event.streams;
		if (remote) {
			audio.srcObject = remote;
			resolveRemote(remote);
			diag("remote-track", {
				sessionId,
				elapsedMs: Math.round(performance.now() - sessionStart),
				trackCount: remote.getTracks().length,
				remoteTracks: mediaTrackSummary(remote),
				...audioDiagState(audio),
			});
		}
	};

	for (const track of stream.getTracks()) {
		peer.addTrack(track, stream);
		track.addEventListener("mute", () => {
			diag("local-track-mute", {
				sessionId,
				trackKind: track.kind,
				readyState: track.readyState,
				enabled: track.enabled,
				...browserDiagState(),
			});
		});
		track.addEventListener("unmute", () => {
			diag("local-track-unmute", {
				sessionId,
				trackKind: track.kind,
				readyState: track.readyState,
				enabled: track.enabled,
				...browserDiagState(),
			});
		});
		track.addEventListener("ended", () => {
			diag("local-track-ended", {
				sessionId,
				trackKind: track.kind,
				readyState: track.readyState,
				enabled: track.enabled,
				...browserDiagState(),
			});
		});
	}
	diag("local-tracks-added", {
		sessionId,
		count: stream.getTracks().length,
		localTracks: mediaTrackSummary(stream),
		...browserDiagState(),
	});

	const listeners = new Set<EventListener>();
	let messageCount = 0;
	dataChannel.addEventListener("message", (event) => {
		messageCount++;
		let payload: RealtimeServerEvent;
		try {
			payload = JSON.parse(String(event.data)) as RealtimeServerEvent;
		} catch {
			// Non-JSON control messages -- ignore.
			diag("datachannel-non-json", { messageIndex: messageCount });
			return;
		}
		if (payload.type === "error") {
			console.error("[helmor] OpenAI Realtime error", payload);
			// Echo to the JSONL log too — `error` events from the server
			// are the single highest-signal diagnostic and tend to vanish
			// into the console history when the operator only has the
			// log file. The dispatcher echoes its own `server-error` for
			// dispatcher-context errors; this one is the raw stream.
			diag("server-stream-error", {
				sessionId,
				event: payload,
				...browserDiagState(),
			});
		}
		if (isKeyServerEvent(payload.type)) {
			const response = (
				payload as {
					response?: {
						id?: string;
						status?: string;
						usage?: unknown;
						status_details?: {
							error?: { message?: string; code?: string; type?: string };
							reason?: string;
						};
					};
				}
			).response;
			diag("server-key-event", {
				sessionId,
				type: payload.type,
				responseId: response?.id ?? null,
				responseStatus: response?.status ?? null,
				responseError:
					response?.status_details?.error?.message ??
					response?.status_details?.reason ??
					null,
				usage: summarizeResponseUsage(response),
				messageIndex: messageCount,
				dataChannelState: dataChannel.readyState,
				peerConnectionState: peer.connectionState,
				rateLimits: summarizeRateLimits(payload),
				localTracks: mediaTrackSummary(stream),
				...browserDiagState(),
			});
		}
		for (const listener of listeners) {
			listener(payload);
		}
	});

	diag("create-offer");
	const offer = await peer.createOffer();
	await peer.setLocalDescription(offer);
	diag("local-description-set", {
		sdpBytes: offer.sdp?.length ?? 0,
	});

	const sdpExchangeStart = performance.now();
	diag("sdp-exchange-post", { url: REALTIME_CALLS_URL });
	const response = await fetch(REALTIME_CALLS_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${clientSecret.value}`,
			"Content-Type": "application/sdp",
		},
		body: offer.sdp ?? "",
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		diag("sdp-exchange-failed", {
			status: response.status,
			elapsedMs: Math.round(performance.now() - sdpExchangeStart),
			bodyPreview: body.slice(0, 500),
		});
		stopMedia(stream, peer, audio);
		throw new Error(
			`OpenAI Realtime WebRTC setup failed with HTTP ${response.status}: ${body}`,
		);
	}

	const answer = await response.text();
	diag("sdp-exchange-ok", {
		status: response.status,
		elapsedMs: Math.round(performance.now() - sdpExchangeStart),
		answerBytes: answer.length,
	});
	await peer.setRemoteDescription({ type: "answer", sdp: answer });
	diag("remote-description-set", {
		totalElapsedMs: Math.round(performance.now() - sessionStart),
	});

	let stopped = false;
	let sentCount = 0;
	let droppedCount = 0;
	return {
		stop: () => {
			if (stopped) return;
			stopped = true;
			listeners.clear();
			stopMedia(stream, peer, audio);
			diag("stop", {
				sessionId,
				sessionLifetimeMs: Math.round(performance.now() - sessionStart),
				clientEventsSent: sentCount,
				clientEventsDropped: droppedCount,
				serverMessagesReceived: messageCount,
				...browserDiagState(),
			});
		},
		onEvent: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		send: (event) => {
			if (stopped) {
				droppedCount++;
				diag("client-event-dropped", {
					type: event.type,
					reason: "session stopped",
				});
				return;
			}
			if (dataChannel.readyState !== "open") {
				droppedCount++;
				console.warn(
					"[helmor] dropping Realtime client event sent before channel open",
					event.type,
				);
				diag("client-event-dropped", {
					type: event.type,
					reason: "datachannel not open",
					readyState: dataChannel.readyState,
				});
				return;
			}
			sentCount++;
			// Don't echo the full payload — conversation.item.create with
			// an embedded data URL is hundreds of KB. Echo type + key
			// size signals only. The dispatcher itself logs richer detail
			// per event type.
			const payload = JSON.stringify(event);
			if (isKeyClientEvent(event.type)) {
				diag("client-event-sent", {
					sessionId,
					type: event.type,
					bytes: payload.length,
					dataChannelState: dataChannel.readyState,
					peerConnectionState: peer.connectionState,
					localTracks: mediaTrackSummary(stream),
					...browserDiagState(),
				});
			}
			dataChannel.send(payload);
		},
		localStream: stream,
		remoteStream,
	};
}

/** Best-effort string from a thrown value. WebRTC / fetch errors
 *  arrive as a mix of `Error`, `DOMException`, and plain strings; we
 *  want a single-line message for the JSONL field. */
function messageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
}

async function getMicrophoneStream(): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (error) {
		if (isMicrophonePermissionError(error)) {
			throw new Error(
				"Microphone access is blocked by macOS. Open Settings → Experimental → Microphone Access, enable Helmor in Privacy & Security → Microphone, then restart Helmor if macOS asks you to.",
			);
		}
		throw error;
	}
}

function isMicrophonePermissionError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "NotAllowedError" || error.name === "SecurityError")
	);
}

function browserDiagState(): Record<string, unknown> {
	return {
		documentHasFocus: document.hasFocus(),
		visibilityState: document.visibilityState,
	};
}

function audioDiagState(audio: HTMLAudioElement): Record<string, unknown> {
	return {
		audioPaused: audio.paused,
		audioMuted: audio.muted,
		audioReadyState: audio.readyState,
		...browserDiagState(),
	};
}

function mediaTrackSummary(
	stream: MediaStream,
): Array<Record<string, unknown>> {
	return stream.getTracks().map((track) => ({
		kind: track.kind,
		enabled: track.enabled,
		muted: track.muted,
		readyState: track.readyState,
	}));
}

function isKeyServerEvent(type: string | undefined): boolean {
	return (
		type === "session.created" ||
		type === "session.updated" ||
		type === "input_audio_buffer.speech_started" ||
		type === "input_audio_buffer.speech_stopped" ||
		type === "input_audio_buffer.committed" ||
		type === "response.created" ||
		type === "response.done" ||
		type === "response.cancelled" ||
		type === "response.output_item.added" ||
		type === "rate_limits.updated"
	);
}

function isKeyClientEvent(type: string): boolean {
	return type === "conversation.item.create" || type === "response.create";
}

function summarizeRateLimits(
	event: RealtimeServerEvent,
): Array<Record<string, unknown>> | null {
	const rateLimits = event.rate_limits;
	if (!Array.isArray(rateLimits)) return null;
	return rateLimits.map((limit) => {
		if (!limit || typeof limit !== "object") return { value: limit };
		const record = limit as Record<string, unknown>;
		return {
			name: record.name ?? null,
			limit: record.limit ?? null,
			remaining: record.remaining ?? null,
			resetSeconds: record.reset_seconds ?? null,
		};
	});
}

function summarizeResponseUsage(
	response:
		| {
				usage?: unknown;
		  }
		| undefined,
): Record<string, unknown> | null {
	const usage = response?.usage;
	if (!usage || typeof usage !== "object") return null;
	const record = usage as Record<string, unknown>;
	const inputDetails =
		record.input_token_details && typeof record.input_token_details === "object"
			? (record.input_token_details as Record<string, unknown>)
			: {};
	const outputDetails =
		record.output_token_details &&
		typeof record.output_token_details === "object"
			? (record.output_token_details as Record<string, unknown>)
			: {};
	const cachedDetails =
		inputDetails.cached_tokens_details &&
		typeof inputDetails.cached_tokens_details === "object"
			? (inputDetails.cached_tokens_details as Record<string, unknown>)
			: {};
	return {
		totalTokens: record.total_tokens ?? null,
		inputTokens: record.input_tokens ?? null,
		outputTokens: record.output_tokens ?? null,
		inputTextTokens: inputDetails.text_tokens ?? null,
		inputAudioTokens: inputDetails.audio_tokens ?? null,
		inputImageTokens: inputDetails.image_tokens ?? null,
		cachedTokens: inputDetails.cached_tokens ?? null,
		cachedTextTokens: cachedDetails.text_tokens ?? null,
		cachedAudioTokens: cachedDetails.audio_tokens ?? null,
		outputTextTokens: outputDetails.text_tokens ?? null,
		outputAudioTokens: outputDetails.audio_tokens ?? null,
	};
}

function stopMedia(
	stream: MediaStream,
	peer: RTCPeerConnection,
	audio: HTMLAudioElement,
) {
	for (const sender of peer.getSenders()) {
		sender.track?.stop();
	}
	for (const track of stream.getTracks()) {
		track.stop();
	}
	audio.pause();
	audio.srcObject = null;
	peer.close();
}
