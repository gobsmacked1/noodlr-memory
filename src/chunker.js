import { contentHash } from "./sanitize.js";

// RPG source material is full of tables (roll tables, stat blocks, price lists)
// interleaved with prose. Splitting a table across chunk boundaries destroys its
// meaning, so the chunker isolates table regions and keeps each one atomic, while
// prose is chunked normally with overlap.

const DEFAULTS = {
  targetChars: 3200,
  overlapChars: 500,
  minChunkChars: 24,
};

// A markdown table is a header row of pipes followed by a separator row of
// dashes/pipes (| --- | --- |). We treat the whole contiguous block as one unit.
function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}
function looksLikeRow(line) {
  return line.includes("|") && line.trim().length > 0;
}

// Split raw text into ordered segments of {type:'prose'|'table', text, heading}.
export function segment(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const segments = [];
  let prose = [];
  let lastHeading = "";
  const flushProse = () => {
    const joined = prose.join("\n").trim();
    if (joined) segments.push({ type: "prose", text: joined });
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) lastHeading = headingMatch[1].trim();

    const isMarkdownTableStart =
      looksLikeRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]);
    const isHtmlTableStart = /<table[\s>]/i.test(line);

    if (isMarkdownTableStart) {
      flushProse();
      const tableLines = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && looksLikeRow(lines[j])) tableLines.push(lines[j++]);
      segments.push({ type: "table", text: tableLines.join("\n"), heading: lastHeading });
      i = j - 1;
    } else if (isHtmlTableStart) {
      flushProse();
      const tableLines = [line];
      let j = i + 1;
      while (j < lines.length && !/<\/table>/i.test(lines[j])) tableLines.push(lines[j++]);
      if (j < lines.length) tableLines.push(lines[j]);
      segments.push({ type: "table", text: tableLines.join("\n"), heading: lastHeading });
      i = j;
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return segments;
}

// Greedy paragraph packer with character overlap between adjacent chunks.
function chunkProse(text, opts) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";
  const push = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
  };
  for (const para of paragraphs) {
    if (buf && buf.length + para.length + 2 > opts.targetChars) {
      push();
      const tail = buf.slice(Math.max(0, buf.length - opts.overlapChars));
      buf = tail ? `${tail}\n\n${para}` : para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    // A single paragraph larger than target: hard-split it.
    while (buf.length > opts.targetChars * 1.5) {
      chunks.push(buf.slice(0, opts.targetChars).trim());
      buf = buf.slice(opts.targetChars - opts.overlapChars);
    }
  }
  push();
  return chunks;
}

/**
 * Turn one document into ordered, embeddable chunks.
 * @param {{text:string, kind?:string, metadata?:object}} doc
 * @param {object} [options]
 * @returns {{text:string, metadata:object, hash:number, index:number}[]}
 */
export function chunkDocument(doc, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const baseMeta = doc.metadata ? { ...doc.metadata } : {};
  const results = [];
  const emit = (text, kind) => {
    const clean = String(text).trim();
    if (clean.length < opts.minChunkChars && kind !== "table" && kind !== "event") return;
    results.push({ text: clean, kind, metadata: baseMeta });
  };

  // A document flagged as a table (e.g. a normalized Foundry RollTable) or a
  // structured event (LLM-extracted memory) is atomic and never split.
  if (doc.kind === "table" || doc.kind === "event") {
    emit(doc.text, doc.kind);
  } else {
    for (const seg of segment(doc.text)) {
      if (seg.type === "table") {
        const caption = seg.heading ? `${seg.heading}\n` : "";
        emit(`${caption}${seg.text}`, "table");
      } else {
        for (const c of chunkProse(seg.text, opts)) emit(c, "prose");
      }
    }
  }

  return results.map((r, index) => ({
    text: r.text,
    metadata: { ...r.metadata, kind: r.kind },
    hash: contentHash(r.text),
    index,
  }));
}

export const chunkerDefaults = DEFAULTS;
