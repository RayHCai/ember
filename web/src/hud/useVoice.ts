import { useEffect, useRef, useState } from "react";
import { isTypingTarget } from "../hooks/useHotkeys";

// Hold Space to talk: speech recognition turns speech into a chat message.
// Replies to spoken questions are read aloud. ElevenLabs voices need the logic
// service, so until it is connected the device's own voice reads them, and the
// status line says so.

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export interface Voice {
  listening: boolean;
  status: string;
  speak: (text: string) => void;
}

export function useVoice(onHeard: (text: string) => void): Voice {
  const Ctor = recognitionCtor();
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spokenQuestion = useRef(false);
  const handler = useRef(onHeard);
  handler.current = onHeard;

  useEffect(() => {
    if (!Ctor) return;
    let rec: Recognition | null = null;
    let transcript = "";
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target) || rec) return;
      e.preventDefault();
      transcript = "";
      setError(null);
      rec = new Ctor();
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (ev) => {
        for (let i = 0; i < ev.results.length; i++) {
          const r = ev.results[i]!;
          if (r.isFinal) transcript += `${r[0]!.transcript} `;
        }
      };
      rec.onerror = (ev) => setError(ev.error === "not-allowed" ? "Microphone access was denied." : `Voice error: ${ev.error}.`);
      rec.onend = () => {
        setListening(false);
        rec = null;
        if (transcript.trim()) {
          spokenQuestion.current = true;
          handler.current(transcript.trim());
        }
      };
      rec.start();
      setListening(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && rec) rec.stop();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      rec?.stop();
    };
  }, [Ctor]);

  const speak = (text: string) => {
    if (!spokenQuestion.current || !canSpeak) return;
    spokenQuestion.current = false;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };

  let status: string;
  if (!Ctor) status = "Voice unavailable: speech recognition is not supported here. Type instead.";
  else if (error) status = error;
  else if (listening) status = "Listening. Release Space to send.";
  else status = canSpeak ? "Hold Space to talk. Replies use the device voice (ElevenLabs not connected)." : "Hold Space to talk.";

  return { listening, status, speak };
}
