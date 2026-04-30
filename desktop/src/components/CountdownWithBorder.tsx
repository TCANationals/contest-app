interface CountdownWithBorderProps {
  text: string;
  textColor: string;
  borderColor: string;
}

export function CountdownWithBorder({ text, textColor, borderColor }: CountdownWithBorderProps): JSX.Element {
  return (
    <span
      style={{
        color: textColor,
        fontSize: "48px",
        fontWeight: 700,
        letterSpacing: "0.04em",
        WebkitTextStroke: `2px ${borderColor}`
      }}
    >
      {text}
    </span>
  );
}
