import { useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, Lock } from "lucide-react";
import { api, ApiClientError } from "../api.ts";
import { describeClientErrorRef, t, type LocalizedError } from "../i18n.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon } from "./Icon.tsx";
import { UiLanguageSelect } from "./Primitives.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "./ui/card.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group.tsx";
import { Label } from "./ui/label.tsx";

export function LoginView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const language = useUiStore((s) => s.language);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LocalizedError | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onAuthenticated();
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.code === "unauthorized"
          ? { key: "login.invalidPin", text: "" }
          : describeClientErrorRef(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-background p-5"
      data-testid="login-view"
    >
      <Card className="w-full max-w-md shadow-md">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <CardHeader className="gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{t(language, "app.languageLabel")}</span>
              <UiLanguageSelect />
            </div>
            <div className="flex items-center gap-2.5">
              <BrandMark />
              <CardTitle>{t(language, "login.title")}</CardTitle>
            </div>
            <CardDescription className="text-xs">
              {t(language, "login.description")}
            </CardDescription>
          </CardHeader>

          <CardPanel className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground" htmlFor="login-password">
                {t(language, "login.passwordLabel")}
              </Label>
              <InputGroup>
                <InputGroupAddon>
                  <Icon icon={Lock} size={16} />
                </InputGroupAddon>
                <InputGroupInput
                  id="login-password"
                  data-testid="login-password-input"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  autoFocus
                  placeholder={t(language, "login.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </InputGroup>
            </div>

            {error && (
              <Alert variant="error" className="text-xs" data-testid="login-error">
                <Icon icon={AlertTriangle} size={14} />
                <AlertDescription className="text-foreground">
                  {error.key ? t(language, error.key, error.params) : error.text}
                </AlertDescription>
              </Alert>
            )}

            <details className="text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer text-foreground underline-offset-4 hover:underline">
                {t(language, "login.forgotPassword")}
              </summary>
              <p className="mt-2">
                {t(language, "login.resetPrefix")}
                <code>wb service password</code>
                {t(language, "login.resetSuffix")}
              </p>
              <p className="mt-1">
                {t(language, "login.reconnectPrefix")}
                <code>wb node reconnect</code>
                {t(language, "login.reconnectSuffix")}
              </p>
            </details>
          </CardPanel>

          <CardFooter>
            <Button
              className="w-full"
              type="submit"
              data-testid="login-submit-btn"
              disabled={!password.trim()}
              loading={busy}
            >
              <Icon icon={KeyRound} size={16} />
              {busy ? t(language, "login.verifying") : t(language, "login.submit")}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
