import {
  CommandError,
  decodeGetinfo,
  encodeCommandResponse,
} from "../wire/codec12.ts";

/**
 * One-shot getinfo policy, armed only after transport verifies the final AVL ACK.
 * Buffers at most the 27-byte request, rejects extra/early input and poisons on
 * failure. It owns no socket, timer, shell, configuration or real device state.
 */
export class CommandFixture {
  #state: "avl" | "command" | "done" = "avl";
  #bytes = Buffer.alloc(27);
  #received = 0;

  /** Arms the command phase once; repeated or out-of-order transitions fail closed. */
  avlAcknowledged(): void {
    if (this.#state !== "avl") {
      this.#state = "done";
      throw new CommandError();
    }
    this.#state = "command";
  }

  /**
   * Consumes bounded fragments and returns a fixed synthetic response exactly once.
   * Rejects impossible headers as soon as eight bytes arrive, before further reads.
   */
  receive(chunk: Buffer): Buffer | null {
    if (this.#state !== "command" || chunk.length > 27 - this.#received) {
      this.#state = "done";
      throw new CommandError();
    }
    this.#received += chunk.copy(this.#bytes, this.#received);
    if (
      this.#received >= 8 &&
      (this.#bytes.readUInt32BE(0) !== 0 || this.#bytes.readUInt32BE(4) !== 15)
    ) {
      this.#state = "done";
      throw new CommandError();
    }
    if (this.#received !== 27) return null;
    this.#state = "done";
    decodeGetinfo(this.#bytes);
    return encodeCommandResponse("SIMULATOR:read-only");
  }
}
