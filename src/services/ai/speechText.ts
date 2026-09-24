/**
 * Helpers to turn LLM output into text that sounds right when spoken.
 * Models often answer with Markdown, URLs or emojis; TTS engines read those
 * literally ("asterisco asterisco…"), which is slow and sounds broken.
 */

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{FE0F}\u{200D}]/gu;

export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/K\.A\.I\.R\.O\.?/gi, 'KAIRO')
    // Fenced / inline code markers
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    // Markdown links → just the label
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    // Bare URLs are unreadable out loud
    .replace(/https?:\/\/\S+/gi, 'el enlace')
    // Emphasis, headings, list bullets, quotes
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(EMOJI_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
