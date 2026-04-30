import { CountdownWithBorder } from "./components/CountdownWithBorder";

export function App() {
  return (
    <main
      style={{
        width: 380,
        height: 96,
        display: "grid",
        placeItems: "center",
        background: "transparent",
        color: "#888888",
        fontFamily: "JetBrains Mono, ui-monospace, monospace"
      }}
    >
      <CountdownWithBorder text="--:--" textColor="#888888" borderColor="#000000" />
    </main>
  );
}
