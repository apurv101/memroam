// Pre-commit secrets scan. Git makes mistakes permanent (2026-08-21 history
// leak), so content that looks like a credential is refused before any blob
// is created — the model is told to redact and retry.

const PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
  [/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/, "a GitHub token"],
  [/github_pat_[A-Za-z0-9_]{22,}/, "a GitHub fine-grained token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/sk-[A-Za-z0-9_-]{20,}/, "an API secret key"],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "a JWT"],
  [/\b(?:secret|api[_-]?key|password|token)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/i, "a hardcoded credential assignment"],
];

export function scanForSecrets(text) {
  for (const [re, what] of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      return (
        `refusing to save: the content appears to contain ${what} (matched near "${m[0].slice(0, 12)}…"). ` +
        `Memories are committed to a git repository where history is permanent — redact the credential ` +
        `(describe where it lives instead of its value) and retry.`
      );
    }
  }
  return null;
}
