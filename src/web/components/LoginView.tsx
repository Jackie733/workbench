import { useState, type FormEvent } from "react";
import { KeyRound, Lock } from "lucide-react";
import { api } from "../api.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon } from "./Icon.tsx";

export function LoginView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--bg)",
      }}
      data-testid="login-view"
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: "100%",
          maxWidth: 400,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.08)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <BrandMark />
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Workbench 局域网登录</h2>
        </div>
        <p className="muted xs" style={{ margin: "0 0 16px" }}>
          当前 Hub 已启用局域网访问鉴权。请输入主控设备上的访问密码（可在主控机执行{" "}
          <code>wb service password</code> 查看或重置）。
        </p>

        <label className="muted xs" htmlFor="login-password" style={{ display: "block", marginBottom: 6 }}>
          访问密码
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span className="muted" style={{ display: "inline-flex" }}>
            <Icon icon={Lock} size={16} />
          </span>
          <input
            id="login-password"
            data-testid="login-password-input"
            type="password"
            autoFocus
            className="input"
            placeholder="输入 Hub 访问密码…"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <div className="callout danger xs" style={{ marginBottom: 12 }} data-testid="login-error">
            {error}
          </div>
        )}

        <button
          className="btn primary"
          type="submit"
          data-testid="login-submit-btn"
          style={{ width: "100%", justifyContent: "center" }}
          disabled={busy || !password.trim()}
        >
          <Icon icon={KeyRound} size={16} /> {busy ? "正在验证…" : "登录工作台"}
        </button>
      </form>
    </div>
  );
}
