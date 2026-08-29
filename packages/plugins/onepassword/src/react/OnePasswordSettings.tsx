import { useEffect, useRef, useState } from "react";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/react/components/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@executor-js/react/components/dialog";
import {
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
} from "@executor-js/react/components/card-stack";

import {
  onepasswordConfigsAtom,
  onepasswordVaultsAtom,
  configureOnePassword,
  removeOnePasswordConfig,
  onepasswordWriteKeys,
} from "./atoms";
import type { RedactedOnePasswordConfig, Vault } from "../sdk/types";

// ---------------------------------------------------------------------------
// Vault picker — single select
// ---------------------------------------------------------------------------

const VAULT_LIST_ERROR_FALLBACK = "Failed to list vaults";

const formatVaultListError = (error: Error): string => {
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed `message`
  const message = error.message.trim();
  return message ? `${VAULT_LIST_ERROR_FALLBACK}: ${message}` : VAULT_LIST_ERROR_FALLBACK;
};

function VaultPicker(props: {
  authKind: "desktop-app" | "service-account";
  accountName: string;
  selectedVault: Vault | null;
  onSelectedChange: (vault: Vault | null) => void;
}) {
  const account = props.accountName.trim();
  const vaultsAtom = onepasswordVaultsAtom(props.authKind, account);
  const vaultsResult = useAtomValue(vaultsAtom);
  const refreshVaults = useAtomRefresh(vaultsAtom);

  const isCachedRef = useRef(false);
  isCachedRef.current = AsyncResult.isSuccess(vaultsResult);
  useEffect(() => {
    if (isCachedRef.current) refreshVaults();
  }, [refreshVaults]);

  const { vaults, isLoading, error } = AsyncResult.matchWithError(
    vaultsResult as AsyncResult.AsyncResult<
      { vaults: ReadonlyArray<{ id: string; name: string }> },
      Error
    >,
    {
      onInitial: () => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: true,
        error: null,
      }),
      onError: (queryError) => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: false,
        error: formatVaultListError(queryError),
      }),
      onDefect: () => ({
        vaults: [] as { id: string; name: string }[],
        isLoading: false,
        error: VAULT_LIST_ERROR_FALLBACK,
      }),
      onSuccess: ({ value }) => {
        const v = value.vaults;
        const onlyVault = v.length === 1 ? v[0] : undefined;
        if (onlyVault && !props.selectedVault) {
          queueMicrotask(() => props.onSelectedChange(onlyVault));
        }
        return { vaults: [...v], isLoading: false, error: null };
      },
    },
  );

  if (!account) {
    return (
      <p className="text-[11px] text-muted-foreground/50 py-1">
        Enter account details to load vaults.
      </p>
    );
  }

  const loadedIds = new Set(vaults.map((v) => v.id));
  const stale =
    props.selectedVault && !loadedIds.has(props.selectedVault.id) ? [props.selectedVault] : [];
  const rows = [...vaults, ...stale];

  return (
    <div className="grid gap-2">
      {isLoading ? (
        <p className="text-[11px] text-muted-foreground/50 py-1">Loading vaults…</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/50 py-1">No vaults found.</p>
      ) : (
        <div className="grid max-h-44 gap-0.5 overflow-y-auto rounded-md border border-input p-1">
          {rows.map((vault) => {
            const isSelected = props.selectedVault?.id === vault.id;
            return (
              <div
                key={vault.id}
                role="button"
                tabIndex={0}
                onClick={() => props.onSelectedChange(vault)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onSelectedChange(vault);
                  }
                }}
                className={`flex cursor-pointer items-center justify-between rounded-sm px-2.5 py-1.5 text-[13px] transition-colors ${
                  isSelected
                    ? "bg-primary text-primary-foreground font-medium"
                    : "hover:bg-muted/50 text-foreground"
                }`}
              >
                <span className="truncate">{vault.name}</span>
                {!loadedIds.has(vault.id) && (
                  <span className="ml-auto shrink-0 text-[11px] opacity-60">not found</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-1.5">
          <p className="text-[11px] text-destructive leading-relaxed whitespace-pre-line">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config dialog
// ---------------------------------------------------------------------------

function ConfigDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: {
    id: string;
    authKind: string;
    accountName: string;
    vaultId: string;
    vaultName?: string;
    name: string;
  };
}) {
  const isEdit = !!props.initial;
  const [authKind, setAuthKind] = useState<"desktop-app" | "service-account">(
    (props.initial?.authKind as "desktop-app" | "service-account") ?? "desktop-app",
  );
  const [accountName, setAccountName] = useState(props.initial?.accountName ?? "my.1password.com");
  const [selectedVault, setSelectedVault] = useState<Vault | null>(
    props.initial?.vaultId
      ? { id: props.initial.vaultId, name: props.initial.vaultName ?? props.initial.vaultId }
      : null,
  );
  const [displayName, setDisplayName] = useState(props.initial?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doConfigure = useAtomSet(configureOnePassword, { mode: "promiseExit" });

  const reset = () => {
    if (!isEdit) {
      setAuthKind("desktop-app");
      setAccountName("my.1password.com");
      setSelectedVault(null);
      setDisplayName("");
    }
    setError(null);
    setSaving(false);
  };

  const handleSave = async () => {
    if (!accountName.trim() || !selectedVault) return;
    setSaving(true);
    setError(null);

    const auth =
      authKind === "desktop-app"
        ? { kind: "desktop-app" as const, accountName: accountName.trim() }
        : { kind: "service-account" as const, token: accountName.trim() };

    const name = displayName.trim() || selectedVault.name || "1Password";
    const id =
      props.initial?.id ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      `vault-${Date.now()}`;

    const exit = await doConfigure({
      payload: {
        id,
        name,
        auth,
        vaultId: selectedVault.id,
        vaultName: selectedVault.name,
      },
      reactivityKeys: onepasswordWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to save configuration");
      setSaving(false);
      return;
    }

    props.onOpenChange(false);
    reset();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        if (!v) reset();
        props.onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            {isEdit ? "Edit 1Password vault" : "Connect 1Password vault"}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            Link a 1Password vault to resolve secrets via the desktop app or a service account.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-3">
          {/* Auth method */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Auth method
            </Label>
            <Select
              value={authKind}
              onValueChange={(v) => setAuthKind(v as "desktop-app" | "service-account")}
            >
              <SelectTrigger className="h-9 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desktop-app">Desktop App (biometric)</SelectItem>
                <SelectItem value="service-account">Service Account</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Account / token */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {authKind === "desktop-app" ? "Account domain" : "Service account token"}
            </Label>
            <Input
              placeholder={authKind === "desktop-app" ? "my.1password.com" : "ops_..."}
              value={accountName}
              onChange={(e) => setAccountName((e.target as HTMLInputElement).value)}
              className="font-mono text-[13px] h-9"
            />
            <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
              {authKind === "desktop-app"
                ? "Requires the 1Password desktop app with biometric unlock."
                : "The token is stored in this provider's owner-scoped config and never surfaced again."}
            </p>
          </div>

          {/* Vault */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Vault
            </Label>
            <VaultPicker
              authKind={authKind}
              accountName={accountName}
              selectedVault={selectedVault}
              onSelectedChange={setSelectedVault}
            />
          </div>

          {/* Display name */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Display name
            </Label>
            <Input
              placeholder="1Password"
              value={displayName}
              onChange={(e) => setDisplayName((e.target as HTMLInputElement).value)}
              className="text-[13px] h-9"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive whitespace-pre-line">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!accountName.trim() || !selectedVault || saving}
          >
            {saving ? "Saving…" : isEdit ? "Update" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------

export default function OnePasswordSettings() {
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    initial?: {
      id: string;
      authKind: string;
      accountName: string;
      vaultId: string;
      vaultName?: string;
      name: string;
    };
  }>({ open: false });

  const configsResult = useAtomValue(onepasswordConfigsAtom);
  const doRemove = useAtomSet(removeOnePasswordConfig, { mode: "promiseExit" });

  const handleRemove = async (id: string) => {
    await doRemove({
      query: { id },
      reactivityKeys: onepasswordWriteKeys,
    });
  };

  const configs: readonly RedactedOnePasswordConfig[] = AsyncResult.match(
    configsResult as AsyncResult.AsyncResult<
      { configs: readonly RedactedOnePasswordConfig[] },
      unknown
    >,
    {
      onInitial: () => [],
      onFailure: () => [],
      onSuccess: ({ value }) => value.configs,
    },
  );
  const isLoading = AsyncResult.match(
    configsResult as AsyncResult.AsyncResult<
      { configs: readonly RedactedOnePasswordConfig[] },
      unknown
    >,
    {
      onInitial: () => true,
      onFailure: () => false,
      onSuccess: () => false,
    },
  );
  const isError = AsyncResult.match(
    configsResult as AsyncResult.AsyncResult<
      { configs: readonly RedactedOnePasswordConfig[] },
      unknown
    >,
    {
      onInitial: () => false,
      onFailure: () => true,
      onSuccess: () => false,
    },
  );

  return (
    <>
      {isLoading ? (
        <CardStackEntry>
          <CardStackEntryContent>
            <CardStackEntryDescription>Loading…</CardStackEntryDescription>
          </CardStackEntryContent>
        </CardStackEntry>
      ) : isError ? (
        <CardStackEntry>
          <CardStackEntryContent>
            <CardStackEntryDescription className="text-destructive">
              Failed to load configuration
            </CardStackEntryDescription>
          </CardStackEntryContent>
        </CardStackEntry>
      ) : configs.length === 0 ? (
        <CardStackEntry>
          <CardStackEntryContent>
            <CardStackEntryDescription>
              Resolve secrets from your 1Password vaults.
            </CardStackEntryDescription>
          </CardStackEntryContent>
          <CardStackEntryActions>
            <Button
              variant="link"
              size="sm"
              className="h-7 px-0 text-[12px] shrink-0"
              onClick={() => setDialogState({ open: true })}
            >
              Add 1Password vault
            </Button>
          </CardStackEntryActions>
        </CardStackEntry>
      ) : (
        <>
          {configs.map((config) => (
            <CardStackEntry key={config.id}>
              <CardStackEntryContent>
                <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[12px]">
                  <span className="text-muted-foreground/60">Name</span>
                  <span className="font-medium text-foreground truncate">{config.name}</span>
                  <span className="text-muted-foreground/60">Auth</span>
                  <span className="font-mono text-foreground/80 truncate">
                    {config.auth.kind === "desktop-app"
                      ? config.auth.accountName
                      : "service-account"}
                  </span>
                  <span className="text-muted-foreground/60">Vault</span>
                  <span className="text-foreground/80 truncate">
                    {config.vaultName ?? config.vaultId}
                  </span>
                </div>
              </CardStackEntryContent>
              <CardStackEntryActions>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[12px]"
                  onClick={() =>
                    setDialogState({
                      open: true,
                      initial: {
                        id: config.id,
                        authKind: config.auth.kind,
                        accountName:
                          config.auth.kind === "desktop-app" ? config.auth.accountName : "",
                        vaultId: config.vaultId,
                        vaultName: config.vaultName,
                        name: config.name,
                      },
                    })
                  }
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[12px] text-destructive/70 hover:text-destructive"
                  onClick={() => handleRemove(config.id)}
                >
                  Disconnect
                </Button>
              </CardStackEntryActions>
            </CardStackEntry>
          ))}
          <div className="flex justify-start px-4 py-2 border-t border-border/40">
            <Button
              variant="link"
              size="sm"
              className="h-7 px-0 text-[12px] shrink-0"
              onClick={() => setDialogState({ open: true })}
            >
              + Add 1Password vault
            </Button>
          </div>
        </>
      )}

      {dialogState.open && (
        <ConfigDialog
          open={dialogState.open}
          onOpenChange={(open) => setDialogState((prev) => ({ ...prev, open }))}
          initial={dialogState.initial}
        />
      )}
    </>
  );
}
