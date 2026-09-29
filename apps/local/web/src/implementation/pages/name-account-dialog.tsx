import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { Account } from "@executor-js/sdk";
import { QueryView } from "@executor-js/ui/dashboard/context";
import {
  NameAccountForm,
  NameAccountHeader,
  NameAccountModal,
} from "@executor-js/ui/dashboard/name-account";
import { accountAtom, accountToNameAtom, renameAccountAtom } from "../../contracts/accounts.ts";
import { Failure, LoadingRows } from "../components/common.tsx";

/** Prompt for a name for a newly connected account, over whatever page follows. */
export function NameAccountDialog() {
  const pending = useAtomValue(accountToNameAtom);
  const setPending = useAtomSet(accountToNameAtom);
  const [busy, setBusy] = useState(false);
  if (pending === undefined) return null;
  const close = () => setPending(undefined);
  return (
    <NameAccountModal
      key={pending.account}
      handoff={pending.saved !== undefined}
      busy={busy}
      onClose={close}
    >
      {pending.saved ? (
        <>
          <NameAccountHeader provider={pending.saved.provider} />
          <LocalNameAccount
            account={{ id: pending.account, label: pending.saved.account.label }}
            providerName={pending.saved.provider.definition.name}
            onPendingChange={setBusy}
            onDone={close}
          />
        </>
      ) : (
        // After an OAuth return the prompt has only the account ID, so it reads the account first.
        <QueryView
          query={accountAtom(pending.account)}
          Failure={Failure}
          pending={
            <>
              <NameAccountHeader />
              <LoadingRows />
            </>
          }
        >
          {(data) => (
            <>
              <NameAccountHeader provider={data.provider} />
              <LocalNameAccount
                account={data.account}
                providerName={data.provider.definition.name}
                onPendingChange={setBusy}
                onDone={close}
              />
            </>
          )}
        </QueryView>
      )}
    </NameAccountModal>
  );
}

function LocalNameAccount({
  account,
  providerName,
  onPendingChange,
  onDone,
}: {
  readonly account: Pick<Account, "id" | "label">;
  readonly providerName: string;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onDone: () => void;
}) {
  const rename = useAtomSet(renameAccountAtom(account.id), { mode: "promiseExit" });
  return (
    <NameAccountForm
      account={account}
      providerName={providerName}
      rename={rename}
      Failure={Failure}
      onPendingChange={onPendingChange}
      onDone={onDone}
    />
  );
}
