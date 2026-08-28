import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { ExecutorProvider } from "@executor-js/react/api/provider";
import { ExecutorPluginsProvider } from "@executor-js/sdk/client";
import { ArtifactRendererProvider } from "@executor-js/react/api/artifact-renderer";
import { OrganizationProvider } from "@executor-js/react/api/organization-context";
import { OrgSlugGate } from "@executor-js/react/multiplayer/org-slug-gate";
import { Toaster } from "@executor-js/react/components/sonner";
import { Button } from "@executor-js/react/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@executor-js/react/components/card";
import { AuthProvider, useAuth } from "@executor-js/react/multiplayer/auth-context";
import { Shell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { useAdminNavItems } from "@executor-js/react/multiplayer/use-admin-nav";
import { plugins as clientPlugins } from "virtual:executor/plugins-client";

import { authClient } from "../auth-client";
import { DevicePage } from "../chromeless/device-page";
import { McpConsentPage } from "../chromeless/mcp-consent-page";
import { LoginPage } from "../login";
import { SetupPage } from "../setup";
import { fetchNeedsSetup, SetupStatusError } from "../setup-status";

// ---------------------------------------------------------------------------
// Unified web SPA root: supporting both Better Auth and Cloudflare Access.
// If the /api/setup-status endpoint returns 404, we assume Access mode is
// active, bypassing the in-app login/setup forms and delegating authentication
// endpoints to Cloudflare Access (/cdn-cgi/access/*).
// ---------------------------------------------------------------------------

const artifactRendererLoader = () => import("@executor-js/mcp-apps-shell/shell/artifact-renderer");

export const Route = createRootRoute({
  notFoundComponent: NotFoundPage,
  component: RootComponent,
});

const selfHostNavItems = [
  ...defaultShellNavItems,
  { to: "/api-keys", label: "API keys" },
  { to: "/admin", label: "Admin" },
];

const selfHostAdminNavItems = [{ to: "/users", label: "Users" }];

function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <section className="w-full max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">404</p>
        <h1 className="mt-2 text-xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          There&apos;s nothing at this address.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
        >
          Go home
        </a>
      </section>
    </main>
  );
}

const Loading = () => (
  <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
    Loading…
  </div>
);

const SetupStatusErrorCard = ({ onRetry }: { onRetry: () => void }) => (
  <div className="flex min-h-screen items-center justify-center bg-background p-6">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Can't reach the server</CardTitle>
        <CardDescription>
          Executor couldn't check this instance's setup state. Make sure the server is running, then
          retry.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  </div>
);

function AuthGate({
  children,
  authMode,
  setAuthMode,
}: {
  children: ReactNode;
  authMode: "access" | "builtin" | "loading";
  setAuthMode: (mode: "access" | "builtin" | "loading") => void;
}) {
  const auth = useAuth();
  const [setupStatus, setSetupStatus] = useState<
    | { state: "checking"; attempt: number }
    | { state: "ready"; needsSetup: boolean }
    | { state: "error"; attempt: number }
  >({ state: "checking", attempt: 0 });

  useEffect(() => {
    if (auth.status !== "unauthenticated") return;
    let alive = true;
    setSetupStatus((current) => ({ state: "checking", attempt: current.attempt }));
    void fetchNeedsSetup().then(
      (value) => {
        if (alive) {
          setAuthMode("builtin");
          setSetupStatus({ state: "ready", needsSetup: value });
        }
      },
      (err) => {
        if (alive) {
          if (err instanceof SetupStatusError && err.status === 404) {
            setAuthMode("access");
            window.location.href = "/cdn-cgi/access/login";
          } else {
            setAuthMode("builtin");
            setSetupStatus((current) => ({
              state: "error",
              attempt: current.state === "ready" ? 0 : current.attempt,
            }));
          }
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [auth.status, setupStatus.attempt, setAuthMode]);

  if (auth.status === "loading" || authMode === "loading") return <Loading />;
  if (auth.status === "unauthenticated") {
    if (authMode === "access") {
      return <Loading />;
    }
    if (setupStatus.state === "checking") return <Loading />;
    if (setupStatus.state === "error") {
      return (
        <SetupStatusErrorCard
          onRetry={() =>
            setSetupStatus((current) => ({
              state: "checking",
              attempt: current.state === "ready" ? 0 : current.attempt + 1,
            }))
          }
        />
      );
    }
    return setupStatus.needsSetup ? <SetupPage /> : <LoginPage />;
  }
  return <>{children}</>;
}

function AuthenticatedApp({ authMode }: { authMode: "access" | "builtin" | "loading" }) {
  const auth = useAuth();
  const organization = auth.status === "authenticated" ? (auth.organization ?? null) : null;
  const navItems = useAdminNavItems(selfHostNavItems, selfHostAdminNavItems);

  const handleSignOut = async () => {
    if (authMode === "access") {
      window.location.href = "/cdn-cgi/access/logout";
    } else {
      await authClient.signOut();
      window.location.href = "/";
    }
  };

  const gated = (
    <>
      <Shell onSignOut={handleSignOut} navItems={navItems} />
      <Toaster />
    </>
  );

  return (
    <ExecutorProvider>
      <ExecutorPluginsProvider plugins={clientPlugins}>
        <OrganizationProvider organizationId={organization?.id ?? null}>
          <ArtifactRendererProvider loader={artifactRendererLoader}>
            {organization ? (
              <OrgSlugGate activeSlug={organization.slug}>{gated}</OrgSlugGate>
            ) : (
              gated
            )}
          </ArtifactRendererProvider>
        </OrganizationProvider>
      </ExecutorPluginsProvider>
    </ExecutorProvider>
  );
}

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [authMode, setAuthMode] = useState<"access" | "builtin" | "loading">("loading");

  useEffect(() => {
    let alive = true;
    fetchNeedsSetup().then(
      () => {
        if (alive) setAuthMode("builtin");
      },
      (err) => {
        if (alive) {
          if (err instanceof SetupStatusError && err.status === 404) {
            setAuthMode("access");
          } else {
            setAuthMode("builtin");
          }
        }
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (pathname.startsWith("/join/")) {
    return (
      <>
        <Outlet />
        <Toaster />
      </>
    );
  }

  if (pathname === "/mcp-consent") {
    return (
      <AuthProvider>
        <AuthGate authMode={authMode} setAuthMode={setAuthMode}>
          <McpConsentPage />
          <Toaster />
        </AuthGate>
      </AuthProvider>
    );
  }

  if (pathname === "/device") {
    return (
      <AuthProvider>
        <AuthGate authMode={authMode} setAuthMode={setAuthMode}>
          <DevicePage />
          <Toaster />
        </AuthGate>
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <AuthGate authMode={authMode} setAuthMode={setAuthMode}>
        <AuthenticatedApp authMode={authMode} />
      </AuthGate>
    </AuthProvider>
  );
}
