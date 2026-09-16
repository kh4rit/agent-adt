import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { deflateRawSync, inflateRawSync } from "node:zlib"

/** One file of an archive; paths use forward slashes and are relative to the archive root. */
export interface ZipEntry {
  path: string
  data: Buffer
}

export interface ZipListing {
  path: string
  size: number
  compressedSize: number
  directory: boolean
  /** Decompresses the entry on demand. */
  data(): Buffer
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const dosDateTime = (d: Date) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
})

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL_DIR = 0x06054b50
const UTF8_NAMES = 0x0800

/** Builds a zip archive (deflate, UTF-8 file names) the way `fiori deploy` / adm-zip does. */
export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now)
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of sorted) {
    const name = Buffer.from(e.path, "utf8")
    const crc = crc32(e.data)
    const deflated = deflateRawSync(e.data)
    const method = deflated.length < e.data.length ? 8 : 0
    const packed = method === 8 ? deflated : e.data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_NAMES, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_NAMES, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_DIR, 0)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** Reads the central directory of a zip archive. */
export function readZip(buf: Buffer): ZipListing[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL_DIR) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive (end of central directory not found)")
  const count = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)
  const out: ZipListing[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== CENTRAL_HEADER) throw new Error("Corrupt zip archive (central directory entry expected)")
    const method = buf.readUInt16LE(pos + 10)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const size = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const path = buf.toString("utf8", pos + 46, pos + 46 + nameLen)
    out.push({
      path,
      size,
      compressedSize,
      directory: path.endsWith("/"),
      data: () => {
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
        const packed = buf.subarray(start, start + compressedSize)
        if (method === 0) return Buffer.from(packed)
        if (method === 8) return inflateRawSync(packed)
        throw new Error(`Unsupported zip compression method ${method} for ${path}`)
      }
    })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * Collects the files of a folder for an archive. `exclude` patterns are tested against the
 * path relative to the folder with a leading slash (so "/test/" or "\\.map$" work like the
 * `exclude` list of ui5-deploy.yaml).
 */
export function collectFiles(dir: string, exclude: RegExp[] = []): ZipEntry[] {
  const out: ZipEntry[] = []
  const walk = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name)
      const rel = relative(dir, full).split(sep).join("/")
      if (exclude.some(r => r.test(`/${rel}`))) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push({ path: rel, data: readFileSync(full) })
    }
  }
  walk(dir)
  return out
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
