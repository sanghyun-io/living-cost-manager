import { ImageResponse } from "next/og";

export const dynamic = "force-static";
const size = { width: 1200, height: 630 };

export function GET() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#f4f7f6", color: "#163e34", padding: "70px 80px" }}>
      <div style={{ display: "flex", fontSize: 28, color: "#116b58" }}>LIVING COST MANAGER</div>
      <div style={{ display: "flex", flexDirection: "column", fontSize: 70, fontWeight: 700, lineHeight: 1.15 }}><span>Know your fixed costs.</span><span>Review each renewal.</span></div>
      <div style={{ display: "flex", gap: 22, fontSize: 25 }}>
        {["Fixed costs", "Renewal dates", "Review decisions"].map((label) => <div key={label} style={{ display: "flex", padding: "18px 24px", background: "#e2eee8", borderRadius: 12 }}>{label}</div>)}
      </div>
    </div>, size
  );
}
