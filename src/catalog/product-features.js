export const FEATURE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'dac', name: 'DAC搭載', order: 1 }),
  Object.freeze({ id: 'network_playback', name: 'ネットワーク対応', order: 2 }),
  Object.freeze({ id: 'headphone_output', name: 'ヘッドホン出力', order: 3 }),
  Object.freeze({ id: 'phono_input', name: 'フォノ入力', order: 4 })
]);

const FEATURE_IDS = new Set(FEATURE_DEFINITIONS.map(feature => feature.id));

const PRESENT_RULES = [
  ['dac', /\bdac\b|dac\s*(?:内蔵|搭載)|d\s*[/\-]\s*a\s*(?:converter|コンバータ(?:ー)?)|da\s*コンバータ(?:ー)?/i],
  ['network_playback', /network\s+(?:player|transport|streaming)|streamer|streaming\s+(?:player|transport)|ネットワーク(?:再生|対応|プレーヤー|プレイヤー|トランスポート)/i],
  ['headphone_output', /headphone\s*(?:out|output|jack)|ヘッドホン(?:出力|端子)/i],
  ['phono_input', /phono\s*(?:in|input)|フォノ入力/i]
];

export function isFeatureId(value) {
  return FEATURE_IDS.has(value);
}

export function inferFeatureFacts(text = '', { source = 'title', confidence = 0.8, verifiedAt = null } = {}) {
  const value = String(text || '').normalize('NFKC');
  if (!value.trim()) return [];
  const facts = [];
  for (const [featureId, pattern] of PRESENT_RULES) {
    if (!pattern.test(value)) continue;
    facts.push({ featureId, state: 'present', source, confidence, verifiedAt });
  }
  return facts;
}

export function normalizeFeatureFacts(facts = []) {
  const byKey = new Map();
  for (const fact of facts) {
    if (!isFeatureId(fact?.featureId)) continue;
    if (fact.state !== 'present' && fact.state !== 'absent') continue;
    const source = String(fact.source || 'unknown');
    const key = `${fact.featureId}:${source}`;
    byKey.set(key, {
      featureId: fact.featureId,
      state: fact.state,
      source,
      confidence: Math.max(0, Math.min(1, Number(fact.confidence) || 0)),
      verifiedAt: fact.verifiedAt || null
    });
  }
  return [...byKey.values()];
}
