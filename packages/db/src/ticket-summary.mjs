const DEFAULT_MAX_SUMMARY_LENGTH = 140;

export function compactTicketSummary(value, fallback = "", options = {}) {
  const maxLength = Number.isInteger(options.maxLength) && options.maxLength > 20
    ? options.maxLength
    : DEFAULT_MAX_SUMMARY_LENGTH;
  const normalized = normalizeTicketSummary(value) || normalizeTicketSummary(fallback) || "";
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const slice = normalized.slice(0, maxLength - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed = slice.slice(0, lastSpace > Math.floor(maxLength * 0.6) ? lastSpace : maxLength - 1).trim();
  return `${trimmed}...`;
}

function normalizeTicketSummary(value) {
  const text = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^[-*_]{3,}$/.test(line));
  if (!text) {
    return "";
  }
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
