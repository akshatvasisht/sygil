interface SygilLogoProps {
  size?: number;
  color?: string;
  className?: string;
}

export function SygilLogo({ size = 24, color = "#e0e0e0", className }: SygilLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <g transform="rotate(-18 256 256)">
        <line x1="368" y1="144" x2="144" y2="144" stroke={color} strokeWidth="48" strokeLinecap="square" />
        <line x1="144" y1="144" x2="368" y2="368" stroke={color} strokeWidth="48" strokeLinecap="square" />
        <line x1="368" y1="368" x2="144" y2="368" stroke={color} strokeWidth="48" strokeLinecap="square" />
        <rect x="96" y="96" width="96" height="96" fill={color} />
        <rect x="320" y="96" width="96" height="96" fill={color} />
        <rect x="320" y="320" width="96" height="96" fill={color} />
        <rect x="96" y="320" width="96" height="96" fill={color} />
      </g>
    </svg>
  );
}
