import type { Account, Provider } from "@executor-js/sdk";
import { Exit, type Cause } from "effect";
import { useState, type ComponentType, type ReactNode } from "react";
import { providerDisplayUrl, type FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog.tsx";
import { Input } from "../components/input.tsx";
import { ProviderIcon } from "./common.tsx";

/**
 * A new account waiting to be named. `saved` is present when the prompt follows the form that saved
 * it; the prompt then renders at once and takes that dialog's place without animating.
 */
export interface AccountToName {
  readonly account: Account["id"];
  readonly saved?: { readonly account: Pick<Account, "label">; readonly provider: Provider };
}

/** The dialog shell for naming a new account; hosts supply the form or its loading state. */
export function NameAccountModal({
  handoff,
  busy,
  onClose,
  children,
}: {
  readonly handoff: boolean;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        {...(handoff ? { "data-name-account-handoff": "" } : {})}
        {...(handoff ? { overlayClassName: "name-account-handoff" } : {})}
        className="max-h-[85dvh] gap-5 overflow-x-hidden overflow-y-auto sm:max-w-[560px]"
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** The provider's identity and the dialog's accessible title. */
export function NameAccountHeader({ provider }: { readonly provider?: Provider | undefined }) {
  return (
    <div className="flex items-center gap-3 pr-7">
      {provider && (
        <ProviderIcon
          name={provider.definition.name}
          url={providerDisplayUrl(provider.definition)}
        />
      )}
      <DialogTitle className="min-w-0 text-base">Name this account</DialogTitle>
      <DialogDescription className="sr-only">
        {provider
          ? `Name the ${provider.definition.name} account you connected.`
          : "Loading the connected account."}
      </DialogDescription>
    </div>
  );
}

/** Name an account once it is connected; the host owns renaming and what follows. */
export function NameAccountForm<E>({
  account,
  providerName,
  rename,
  Failure,
  onPendingChange,
  onDone,
}: {
  readonly account: Pick<Account, "label">;
  readonly providerName: string;
  readonly rename: (label: string) => Promise<Exit.Exit<unknown, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly onDone: () => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const updatePending = (value: boolean) => {
    setPending(value);
    onPendingChange?.(value);
  };
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        const next = label.trim();
        if (pending || !next) return;
        if (next === account.label) return onDone();
        updatePending(true);
        setError(undefined);
        const exit = await rename(next);
        updatePending(false);
        if (Exit.isFailure(exit)) return setError(exit.cause);
        onDone();
      }}
    >
      <p className="text-xs leading-relaxed text-muted-foreground">
        {providerName} is connected. Choose a name you’ll recognize.
      </p>
      <label className="flex flex-col gap-2 text-[13px] font-medium">
        Account name
        <Input
          autoFocus
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={pending}
          maxLength={120}
        />
      </label>
      {error && <Failure cause={error} />}
      <Button type="submit" className="w-full" loading={pending} disabled={!label.trim()}>
        Save name
      </Button>
    </form>
  );
}
