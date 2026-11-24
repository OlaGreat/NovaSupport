import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QRCodeButton } from "./qr-code-button";

describe("QRCodeButton toggle", () => {
  it("closes the popover when the toggle button is clicked again", () => {
    render(<QRCodeButton username="alice" />);
    const toggle = screen.getByRole("button", { name: "Show QR code" });

    fireEvent.mouseDown(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.mouseDown(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
