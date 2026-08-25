// The only HTML the hosted tier serves: the consent gate and small
// instructive pages around the GitHub App install flow. No cookies, no JS.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const shell = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a;background:#fafafa;line-height:1.55}
  h1{font-size:1.25rem} code{background:#eee;padding:.1em .35em;border-radius:4px}
  .card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:1.5rem 1.75rem}
  .actions{margin-top:1.5rem;display:flex;gap:.75rem}
  button{font-size:1rem;padding:.55rem 1.4rem;border-radius:8px;border:1px solid #bbb;background:#fff;cursor:pointer}
  button.primary{background:#1a7f37;border-color:#1a7f37;color:#fff}
  .muted{color:#666;font-size:.9rem}
</style></head><body><div class="card">${body}</div></body></html>`;

export const consentPage = ({ clientName, repoFullName, defaultSpace, authreqId, nonce }) =>
  shell(
    "Approve access — memory-vault",
    `<h1>Approve access to your memory vault?</h1>
     <p><strong>${esc(clientName || "An MCP client")}</strong> is requesting read/write access to your
     memory vault, stored in your GitHub repository <strong>${esc(repoFullName)}</strong>
     (default space <code>${esc(defaultSpace)}</code>).</p>
     <p class="muted">Every change it makes becomes a commit in that repository. You can revoke access at
     any time by uninstalling the memory-vault GitHub App from the repository.</p>
     <div class="actions">
       <form method="POST" action="/approve">
         <input type="hidden" name="authreq" value="${esc(authreqId)}">
         <input type="hidden" name="nonce" value="${esc(nonce)}">
         <input type="hidden" name="decision" value="approve">
         <button class="primary" type="submit">Approve</button>
       </form>
       <form method="POST" action="/approve">
         <input type="hidden" name="authreq" value="${esc(authreqId)}">
         <input type="hidden" name="nonce" value="${esc(nonce)}">
         <input type="hidden" name="decision" value="deny">
         <button type="submit">Deny</button>
       </form>
     </div>`,
  );

export const errorPage = (title, message) =>
  shell(`${title} — memory-vault`, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);

export const installProblemPage = (message, slug) =>
  shell(
    "Installation problem — memory-vault",
    `<h1>Almost there</h1><p>${esc(message)}</p>
     <p>Fix the installation here:
     <a href="https://github.com/apps/${esc(slug)}/installations/new">github.com/apps/${esc(slug)}/installations/new</a>
     — choose <strong>Only select repositories</strong> and pick exactly one <strong>private</strong> repository,
     then restart the connection from your chat client.</p>`,
  );

export const landingPage = () =>
  shell(
    "memory-vault",
    `<h1>memory-vault — hosted</h1>
     <p>A persistent memory vault for AI harnesses. Your memories live in your own private GitHub
     repository; this server is a stateless bridge speaking the Model Context Protocol.</p>
     <p class="muted">Connect by adding this server's <code>/mcp</code> URL as a custom connector in a
     harness that supports remote MCP (ChatGPT, claude.ai, Claude Code, …) — sign-in happens automatically.</p>`,
  );
