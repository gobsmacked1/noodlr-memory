// Hybrid retrieval re-ranker (VectFox A2-style, backend-agnostic).
//
// The vector store returns dense (semantic) candidates; this module adds a
// sparse BM25 keyword signal over the candidate pool, fuses the two rankings
// with Reciprocal Rank Fusion, then folds in structured-event signals
// (importance, recency) via a tunable weighted formula. It runs entirely in the
// service over the candidates the store already returned, so it works the same
// for Vectra, Chroma, and Qdrant.

const STOPWORDS = new Set(
  ("a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with from your you i we our").split(
    /\s+/,
  ),
);

export function tokenize(text) {
  const matches = String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return matches.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// BM25 with IDF computed over the candidate pool (VectFox A1/A2 approach).
export function bm25Scores(queryTokens, docsTokens, { k1 = 1.5, b = 0.75 } = {}) {
  const N = docsTokens.length || 1;
  const df = new Map();
  for (const toks of docsTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgdl = docsTokens.reduce((s, t) => s + t.length, 0) / N || 1;
  const idf = (t) => {
    const n = df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };
  const qUnique = [...new Set(queryTokens)];
  return docsTokens.map((toks) => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const dl = toks.length;
    let score = 0;
    for (const q of qUnique) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      score += idf(q) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / (avgdl || 1))));
    }
    return score;
  });
}

// Rank position (0 = best) for each item given its score.
function ranksOf(scores) {
  const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]);
  const rank = new Array(scores.length);
  order.forEach((idx, r) => (rank[idx] = r));
  return rank;
}

const DEFAULT_WEIGHTS = { cosine: 1.0, bm25: 1.0, importance: 0.25, recency: 0.15, entity: 0.2 };

function normEntities(list) {
  if (!Array.isArray(list)) return [];
  return list.map((e) => String(e ?? "").toLowerCase().trim()).filter(Boolean);
}

// Stable identity for a candidate so the same chunk retrieved by several
// sub-queries is fused once. `id`/`hash` come from the store; `collection` is
// added by the query route. Falls back to text for bare unit-test candidates.
function dedupKey(c) {
  const base = c.id ?? c.hash ?? c.text ?? "";
  return `${c.collection ?? ""}:${base}`;
}

// Non-lexical signal terms for a candidate: event importance, recency decay,
// and a soft boost when the candidate's entities intersect the query entities.
function structuredTerms(candidate, w, now, halfLife, queryEntities) {
  const importance = Number(candidate.metadata?.importance);
  const impTerm = Number.isFinite(importance) ? w.importance * (Math.max(0, Math.min(10, importance)) / 10) : 0;

  const ts = Number(candidate.metadata?.ts ?? candidate.metadata?.startTs ?? candidate.metadata?.updatedAt);
  let recTerm = 0;
  if (Number.isFinite(ts) && ts > 0) {
    const ageDays = Math.max(0, (now - ts) / 86400000);
    recTerm = w.recency * Math.pow(0.5, ageDays / halfLife);
  }

  let entTerm = 0;
  if (queryEntities.length) {
    const docEnts = new Set(normEntities(candidate.metadata?.entities));
    if (docEnts.size && queryEntities.some((e) => docEnts.has(e))) entTerm = w.entity;
  }

  return impTerm + recTerm + entTerm;
}

// Lexical fusion (dense cosine rank + sparse BM25 rank) for ONE ranked list,
// returning a per-candidate RRF contribution (plus the raw dense/bm25 scores).
function lexicalRRF(query, candidates, w, rrfK) {
  const qTokens = tokenize(query);
  const docsTokens = candidates.map((c) => tokenize(c.text || ""));
  const bm25 = bm25Scores(qTokens, docsTokens);
  const denseScores = candidates.map((c) => Number(c.score) || 0);
  const denseRank = ranksOf(denseScores);
  const bm25Rank = ranksOf(bm25);

  return candidates.map((c, i) => {
    const rrf = w.cosine * (1 / (rrfK + denseRank[i] + 1)) + w.bm25 * (1 / (rrfK + bm25Rank[i] + 1));
    // Dual-signal bonus: reward candidates that rank well on BOTH signals.
    const both = denseRank[i] < candidates.length / 2 && bm25Rank[i] < candidates.length / 2 && bm25[i] > 0;
    const bonus = both ? rrf * 0.08 : 0;
    return { rrf: rrf + bonus, bm25: bm25[i], dense: denseScores[i] };
  });
}

/**
 * Re-rank dense candidates with a fused dense+sparse+structured score.
 * Single-query convenience wrapper over {@link rerankMulti}.
 * @param {string} query
 * @param {{text:string, score:number, metadata?:object}[]} candidates
 * @param {{weights?:object, rrfK?:number, now?:number, recencyHalfLifeDays?:number, entities?:string[]}} [opts]
 * @returns {(object & {finalScore:number, bm25Score:number, denseScore:number})[]}
 */
export function rerank(query, candidates, opts = {}) {
  if (!candidates.length) return [];
  return rerankMulti([query], [candidates], opts);
}

/**
 * Multi-query (Agent-Mode) re-ranker. Each sub-query has its own candidate
 * list; every list is lexically fused (dense+BM25 RRF) independently, then the
 * per-list RRF contributions are summed per unique doc (multi-list RRF), and the
 * structured signals (importance/recency/entity) are applied once at the end.
 * @param {string[]} queries
 * @param {Array<{text:string, score:number, metadata?:object}[]>} candidateLists  aligned with `queries`
 * @param {{weights?:object, rrfK?:number, now?:number, recencyHalfLifeDays?:number, entities?:string[]}} [opts]
 * @returns {(object & {finalScore:number, bm25Score:number, denseScore:number})[]}
 */
export function rerankMulti(queries, candidateLists, opts = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const rrfK = opts.rrfK ?? 60;
  const now = opts.now ?? Date.now();
  const halfLife = opts.recencyHalfLifeDays ?? 30;
  const queryEntities = normEntities(opts.entities);

  // Fuse each sub-query's ranked list, accumulating RRF mass per unique doc.
  const merged = new Map(); // dedupKey -> { candidate, rrfSum, bm25Best, denseBest }
  for (let qi = 0; qi < queries.length; qi++) {
    const list = candidateLists[qi] || [];
    if (!list.length) continue;
    const contrib = lexicalRRF(queries[qi] ?? "", list, w, rrfK);
    for (let i = 0; i < list.length; i++) {
      const key = dedupKey(list[i]);
      const cur = merged.get(key);
      if (cur) {
        cur.rrfSum += contrib[i].rrf;
        cur.bm25Best = Math.max(cur.bm25Best, contrib[i].bm25);
        cur.denseBest = Math.max(cur.denseBest, contrib[i].dense);
      } else {
        merged.set(key, {
          candidate: list[i],
          rrfSum: contrib[i].rrf,
          bm25Best: contrib[i].bm25,
          denseBest: contrib[i].dense,
        });
      }
    }
  }
  if (!merged.size) return [];

  const scored = [...merged.values()].map(({ candidate, rrfSum, bm25Best, denseBest }) => ({
    ...candidate,
    finalScore: rrfSum + structuredTerms(candidate, w, now, halfLife, queryEntities),
    denseScore: denseBest,
    bm25Score: bm25Best,
  }));

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}
