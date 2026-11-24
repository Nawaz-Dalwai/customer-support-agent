import type { Metadata } from "next";
import TopNavBar from "@/components/TopNavBar";
import InsightsView from "@/components/InsightsView";

export const metadata: Metadata = {
  title: "Insights · Support Agent for Wix (Concept)",
  description: "How the support agent is doing: resolution, handoffs, stuck reasons and cost.",
};

export default function InsightsPage() {
  return (
    <div className="flex h-screen w-full flex-col">
      <TopNavBar />
      <div className="flex-1 overflow-y-auto">
        <InsightsView />
      </div>
    </div>
  );
}
