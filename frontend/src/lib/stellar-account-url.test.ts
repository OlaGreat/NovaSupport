import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { isMuxedAddress, stellarExpertAccountUrl } from "./stellar";

function makeMuxed(base: string, id: bigint): string {
  const raw = Buffer.from(StrKey.decodeEd25519PublicKey(base));
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64BE(id);
  return StrKey.encodeMed25519PublicKey(Buffer.concat([raw, idBytes]));
}

describe("stellarExpertAccountUrl (#1439)", () => {
  it("links a G address directly", () => {
    const g = Keypair.random().publicKey();
    const url = stellarExpertAccountUrl(g);
    expect(url).not.toBeNull();
    expect(url).toContain(`/account/${g}`);
  });

  it("resolves a muxed M address to its underlying G account", () => {
    const g = Keypair.random().publicKey();
    const m = makeMuxed(g, 1n);
    expect(isMuxedAddress(m)).toBe(true);
    const url = stellarExpertAccountUrl(m);
    expect(url).toContain(`/account/${g}`);
    expect(url).not.toContain(m);
  });

  it("returns null and flags unrecognised addresses", () => {
    expect(stellarExpertAccountUrl("not-an-address")).toBeNull();
    expect(isMuxedAddress("not-an-address")).toBe(false);
  });
});
