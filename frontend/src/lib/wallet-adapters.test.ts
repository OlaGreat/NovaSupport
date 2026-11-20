import { describe, expect, it, vi, beforeEach } from "vitest";
import { getWalletAdapter } from "./wallet-adapters";

describe("Lobstr adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as any).lobstr;
  });

  it("passes the network passphrase to signTransaction", async () => {
    const signTransaction = vi.fn().mockResolvedValue({
      signedTxXdr: "signed-xdr",
    });
    (window as any).lobstr = { signTransaction };

    const adapter = getWalletAdapter("lobstr");
    const result = await adapter?.signTransaction("unsigned-xdr", {
      address: "GADDRESS",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    });

    expect(result).toBe("signed-xdr");
    expect(signTransaction).toHaveBeenCalledWith("unsigned-xdr", {
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    });
  });
});
