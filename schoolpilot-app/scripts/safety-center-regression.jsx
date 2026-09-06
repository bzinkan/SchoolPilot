import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { queryClient } from "../src/lib/queryClient";
import { ThemeProvider } from "../src/contexts/ThemeContext";
import SafetyCenter from "../src/products/classpilot/pages/SafetyCenter";
import MonitoringHoursSettings from "../src/products/classpilot/components/MonitoringHoursSettings";
import "../src/index.css";
createRoot(document.getElementById("root")).render(<QueryClientProvider client={queryClient}><ThemeProvider><BrowserRouter><SafetyCenter /><MonitoringHoursSettings settings={{ schoolTimezone: "America/Chicago", enableTrackingHours: true, trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], afterHoursMode: "off" }} /></BrowserRouter></ThemeProvider></QueryClientProvider>);
