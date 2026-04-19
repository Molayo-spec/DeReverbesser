declare module 'lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}

declare module 'audiobuffer-to-wav' {
  export default function toWav(buffer: AudioBuffer, options?: { float32?: boolean }): ArrayBuffer;
}
