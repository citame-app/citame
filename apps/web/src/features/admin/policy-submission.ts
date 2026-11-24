import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, NetworkError, ResponseShapeError } from "~/lib/api/client";
/** Retain a reviewed versioned change through an uncertain response; no browser persistence. */
export function usePolicySubmission<Input, Output>(
  input: Input,
  save: (packet: Input) => Promise<Output>,
  onSaved: (result: Output) => void | Promise<void>,
  retainOnRetryError?: (error: unknown) => boolean,
) {
  const [uncertain, setUncertain] = useState(false);
  const packet = useRef<Input | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutation = useMutation({
    mutationFn: () => {
      packet.current ??= input;
      return save(packet.current);
    },
    onSuccess: async (result) => {
      if (mounted.current) await onSaved(result);
      if (mounted.current) {
        setUncertain(false);
        packet.current = undefined;
      }
    },
    onError: (error) => {
      if (!mounted.current) return;
      if (
        error instanceof NetworkError ||
        error instanceof ResponseShapeError ||
        (error instanceof ApiError && error.status >= 500) ||
        (uncertain && retainOnRetryError?.(error))
      )
        setUncertain(true);
      else {
        setUncertain(false);
        packet.current = undefined;
      }
    },
  });
  return {
    mutation,
    uncertain,
    disabled: mutation.isPending || uncertain,
    changed: () => {
      if (uncertain || mutation.isPending) return;
      packet.current = undefined;
      mutation.reset();
    },
  };
}
