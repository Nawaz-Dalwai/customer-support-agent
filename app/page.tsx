import React from "react";
import TopNavBar from "@/components/TopNavBar";
import ChatArea from "@/components/ChatArea";
import LeftSidebar from "@/components/LeftSidebar";
import RightSidebar from "@/components/RightSidebar";
import config from "@/config";

// The sidebars are client components that only attach window listeners after mount,
// so they can be imported directly (Next 15 disallows `dynamic(..., { ssr: false })` here).
export default function Home() {
  return (
    <div className="flex flex-col h-screen w-full">
      <TopNavBar />
      <div className="flex flex-1 overflow-hidden h-screen w-full">
        {config.includeLeftSidebar && <LeftSidebar />}
        <ChatArea />
        {config.includeRightSidebar && <RightSidebar />}
      </div>
    </div>
  );
}
