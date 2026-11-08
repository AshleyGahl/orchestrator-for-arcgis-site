// zip.js — a minimal, dependency-free zip writer for the viewer package.
// Files are stored uncompressed (the package is small text files), which every unzip tool and
// Windows Explorer open. Names are UTF-8.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** DOS date/time fields used by zip headers. */
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param files [{ path: 'folder/file.txt', content: string | Uint8Array }]
 * @returns Blob (application/zip)
 */
export function createZip(files) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.path.replace(/\\/g, '/'));
    const data = typeof f.content === 'string' ? enc.encode(f.content) : f.content;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);    // local file header
    local.setUint16(4, 20, true);            // version needed
    local.setUint16(6, 0x0800, true);        // flags: UTF-8 names
    local.setUint16(8, 0, true);             // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);  // compressed size
    local.setUint32(22, data.length, true);  // uncompressed size
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);            // extra length
    parts.push(local.buffer, name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);       // central directory header
    cd.setUint16(4, 20, true);               // version made by
    cd.setUint16(6, 20, true);               // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint16(30, 0, true);               // extra
    cd.setUint16(32, 0, true);               // comment
    cd.setUint16(34, 0, true);               // disk
    cd.setUint16(36, 0, true);               // internal attributes
    cd.setUint32(38, 0, true);               // external attributes
    cd.setUint32(42, offset, true);          // where the local header starts
    central.push(cd.buffer, name);

    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);        // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
