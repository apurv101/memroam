// Shared candidate-file plumbing for adapters. Candidates carry the
// capture-time scalar shorthand (source:) plus status: pending; the gardener
// lifts source to origins[] on promotion (contract item 6).

// Ensure an imported file has a frontmatter block carrying name/description
// defaults plus source and status. Existing keys are never overwritten —
// native frontmatter wins; only missing keys are added.
export function upsertCandidateFrontmatter(text, { name, description, source }) {
  const additions = (block) => {
    let add = "";
    if (!/^name:/m.test(block)) add += `name: ${name}\n`;
    if (!/^description:/m.test(block)) add += `description: ${description}\n`;
    if (!/^source:/m.test(block)) add += `source: ${source}\n`;
    if (!/^status:/m.test(block)) add += `status: pending\n`;
    return add;
  };
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      const block = text.slice(4, end);
      const add = additions(block);
      return add ? `---\n${block}\n${add}${text.slice(end + 1)}` : text;
    }
  }
  return `---\n${additions("")}---\n\n${text}`;
}
