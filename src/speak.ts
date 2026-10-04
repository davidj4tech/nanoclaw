import { spawn } from 'child_process';

import { logger } from './logger.js';

/**
 * Speak a reply aloud through agent-media on another host (`media say` over
 * ssh), so it queues with the other voices, honours Do Not Disturb and the
 * speaker routing, and shows in Sasonica with follow-along.
 *
 * NANOCLAW_SPEAK_HOST  ssh host running agent-media (default red5; empty = off)
 * NANOCLAW_SPEAK_VOICE Edge voice (default en-US-AvaNeural), pinned through
 *                      agent-media's per-speaker voice map under the name
 *                      "pixie" so it never sounds like an agent session.
 *
 * Fire-and-forget: the text goes on stdin (never into a command line), and a
 * slow or failed speak never holds up the Matrix reply.
 */
export function speak(text: string): void {
  const host = process.env.NANOCLAW_SPEAK_HOST ?? 'red5';
  if (!host || !text.trim()) return;
  const voice = process.env.NANOCLAW_SPEAK_VOICE || 'en-US-AvaNeural';
  if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+$/.test(voice)) {
    logger.warn({ voice }, 'NANOCLAW_SPEAK_VOICE is not an Edge voice name; not speaking');
    return;
  }
  const remote =
    `MEDIA_SOURCE_WORKSPACE=pixie MEDIA_SESSION_VOICE_MAP=pixie=${voice} ` +
    '"$HOME/.local/bin/media" say';
  try {
    const p = spawn(
      'timeout',
      ['120', 'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host, remote],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let err = '';
    p.stderr?.on('data', (d) => { err += String(d); });
    p.on('error', (e) => logger.warn({ err: e }, 'speak: could not start ssh'));
    p.on('close', (code) => {
      if (code) logger.warn({ code, err: err.slice(0, 300) }, 'speak: media say failed');
    });
    p.stdin?.end(text);
  } catch (e) {
    logger.warn({ err: e }, 'speak failed');
  }
}
