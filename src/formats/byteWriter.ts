export class ByteWriter {
  private chunks: number[] = [];

  get length(): number {
    return this.chunks.length;
  }

  u8(v: number): void {
    this.chunks.push(v & 0xff);
  }

  bytes(arr: number[] | Uint8Array): void {
    for (let i = 0; i < arr.length; i++) this.chunks.push(arr[i] & 0xff);
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.chunks.push(s.charCodeAt(i) & 0xff);
  }

  u16le(v: number): void {
    this.chunks.push(v & 0xff, (v >> 8) & 0xff);
  }

  u24le(v: number): void {
    this.chunks.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff);
  }

  u32le(v: number): void {
    this.chunks.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  f32le(v: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    this.chunks.push(...new Uint8Array(buf));
  }

  /** Overwrite bytes already written, without moving the current write position. */
  patchU32le(offset: number, v: number): void {
    this.chunks[offset] = v & 0xff;
    this.chunks[offset + 1] = (v >> 8) & 0xff;
    this.chunks[offset + 2] = (v >> 16) & 0xff;
    this.chunks[offset + 3] = (v >> 24) & 0xff;
  }

  patchU24le(offset: number, v: number): void {
    this.chunks[offset] = v & 0xff;
    this.chunks[offset + 1] = (v >> 8) & 0xff;
    this.chunks[offset + 2] = (v >> 16) & 0xff;
  }

  patchU16le(offset: number, v: number): void {
    this.chunks[offset] = v & 0xff;
    this.chunks[offset + 1] = (v >> 8) & 0xff;
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}
