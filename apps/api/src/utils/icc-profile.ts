/** Bounded, dependency-free sanitation of ICC v2/v4 RGB matrix/TRC profiles.
 * ICC descriptions, header identity and padding can contain camera metadata.
 * Rebuild only verified numeric rendering data; unsupported transforms refuse
 * publication instead of losing their colour information. */
const MAX_PROFILE_BYTES = 1024 * 1024;
const DESCRIPTION_TAGS = new Set(['desc', 'cprt', 'dmnd', 'dmdd', 'vued', 'pseq', 'psid', 'targ', 'meta', 'tech']);
const XYZ_TAGS = new Set(['rXYZ', 'gXYZ', 'bXYZ', 'wtpt', 'bkpt', 'lumi']);
const CURVE_TAGS = new Set(['rTRC', 'gTRC', 'bTRC']);

function renderingTag(tag: string, data: Buffer): Buffer | null {
  if (data.length < 12) return null;
  const type = data.toString('latin1', 0, 4);
  let length: number;
  if (XYZ_TAGS.has(tag) && type === 'XYZ ') length = 20;
  else if (tag === 'chad' && type === 'sf32') length = 44;
  else if (tag === 'chrm' && type === 'chrm' && data.readUInt16BE(8) === 3 && data.readUInt16BE(10) <= 4) length = 36;
  else if (CURVE_TAGS.has(tag) && type === 'curv') length = 12 + data.readUInt32BE(8) * 2;
  else if (CURVE_TAGS.has(tag) && type === 'para') {
    const parameters = [1, 3, 4, 5, 7][data.readUInt16BE(8)];
    if (parameters === undefined) return null;
    length = 12 + parameters * 4;
  } else return null;
  if (length > data.length) return null;
  const out = Buffer.from(data.subarray(0, length));
  out.fill(0, 4, 8); // type's reserved word
  if (type === 'para') out.fill(0, 10, 12);
  return out;
}

function neutralText(version: number, copyright: boolean): Buffer {
  if (version === 4) {
    const out = Buffer.alloc(28); // one empty enUS localized string
    out.write('mluc'); out.writeUInt32BE(1, 8); out.writeUInt32BE(12, 12);
    out.write('enUS', 16); out.writeUInt32BE(28, 24);
    return out;
  }
  if (copyright) { const out = Buffer.alloc(9); out.write('text'); return out; }
  const out = Buffer.alloc(91); // empty ASCII description, Unicode and script fields
  out.write('desc'); out.writeUInt32BE(1, 8);
  return out;
}

export function sanitizeIccProfile(profile: Buffer): Buffer | null {
  if (profile.length < 132 || profile.length > MAX_PROFILE_BYTES || profile.readUInt32BE(0) !== profile.length) return null;
  const version = profile[8]!;
  if ((version !== 2 && version !== 4) || profile.toString('latin1', 36, 40) !== 'acsp') return null;
  if (!['mntr', 'scnr', 'spac'].includes(profile.toString('latin1', 12, 16)) || profile.toString('latin1', 16, 20) !== 'RGB ' || profile.toString('latin1', 20, 24) !== 'XYZ ') return null;
  if (profile.readUInt32BE(64) > 3) return null;
  const count = profile.readUInt32BE(128);
  const tableEnd = 132 + count * 12;
  if (count > 128 || tableEnd > profile.length) return null;
  const tags = new Map<string, Buffer>();
  const ranges: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  for (let n = 0; n < count; n++) {
    const entry = 132 + n * 12;
    const tag = profile.toString('latin1', entry, entry + 4);
    const start = profile.readUInt32BE(entry + 4), size = profile.readUInt32BE(entry + 8), end = start + size;
    if (seen.has(tag) || start % 4 !== 0 || start < tableEnd || size < 8 || end > profile.length) return null;
    if (ranges.some(r => start < r.end && end > r.start && (start !== r.start || end !== r.end))) return null;
    ranges.push({ start, end }); seen.add(tag);
    if (DESCRIPTION_TAGS.has(tag)) {
      if (tag === 'desc' || tag === 'cprt') tags.set(tag, neutralText(version, tag === 'cprt'));
      continue;
    }
    const data = renderingTag(tag, profile.subarray(start, end));
    if (!data) return null; // no opaque extensions or unverified rendering structures
    tags.set(tag, data);
  }
  for (const required of ['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']) if (!tags.has(required)) return null;
  const header = Buffer.alloc(128);
  profile.copy(header, 8, 8, 24); // version, class and colour spaces
  header.fill(0, 10, 12);
  header.writeUInt16BE(2000, 24); header.writeUInt16BE(1, 26); header.writeUInt16BE(1, 28);
  header.write('acsp', 36);
  header.writeUInt32BE(profile.readUInt32BE(44) & 3, 44); // defined flags only
  header.writeUInt32BE(profile.readUInt32BE(60) & 15, 60); // defined device attributes only
  profile.copy(header, 64, 64, 80); // intent and PCS illuminant
  const table = Buffer.alloc(4 + tags.size * 12); table.writeUInt32BE(tags.size);
  const payload: Buffer[] = [];
  const unique: Array<{ bytes: Buffer; offset: number }> = [];
  let offset = 128 + table.length, n = 0;
  for (const [tag, bytes] of tags) {
    let shared = unique.find(p => p.bytes.equals(bytes));
    if (!shared) {
      shared = { bytes, offset }; unique.push(shared);
      const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
      bytes.copy(padded); payload.push(padded); offset += padded.length;
    }
    table.write(tag, 4 + n * 12); table.writeUInt32BE(shared.offset, 8 + n * 12); table.writeUInt32BE(bytes.length, 12 + n * 12); n++;
  }
  header.writeUInt32BE(offset, 0);
  return Buffer.concat([header, table, ...payload]);
}
