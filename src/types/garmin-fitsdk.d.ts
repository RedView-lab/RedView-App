declare module '@garmin/fitsdk' {
  export class Encoder {
    onMesg(mesgNum: number, mesg: Record<string, unknown>): void;
    close(): Uint8Array;
  }

  export const Profile: {
    MesgNum: Record<string, number>;
    messages: Record<number, { fields: Record<string, unknown> } | undefined>;
    types: Record<string, Record<string, string> | undefined>;
    version: { major: number; minor: number };
  };

  export const Utils: {
    convertDateToDateTime(date: Date): number;
  };

  export class Stream {
    static fromByteArray(bytes: ArrayLike<number>): Stream;
  }

  export class Decoder {
    constructor(stream: Stream);
    isFIT(): boolean;
    checkIntegrity(): boolean;
    read(options?: Record<string, unknown>): { messages: Record<string, Array<Record<string, unknown>>>; errors: unknown[] };
  }

  export const CrcCalculator: {
    calculateCRC(bytes: Uint8Array, start: number, end: number): number;
  };
}