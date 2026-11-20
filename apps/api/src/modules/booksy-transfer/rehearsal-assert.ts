import { DomainError } from "../../errors";

export async function mustReject(
  action: () => Promise<unknown>,
  code: DomainError["code"],
  detail?: string,
) {
  try {
    await action();
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === code &&
      (detail === undefined || error.message === detail)
    )
      return;
    throw error;
  }
  throw new Error(`Expected rehearsal restriction did not apply: ${code}`);
}
