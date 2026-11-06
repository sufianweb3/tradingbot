import { Navigate, Route, Routes } from "react-router-dom";
import { AppProvider } from "./store/AppStore";
import { AppShell } from "./components/AppShell";
import OverviewPage from "./pages/Overview";
import ScannerPage from "./pages/Scanner";
import FeedPage from "./pages/Feed";
import PositionsPage from "./pages/Positions";
import PerformancePage from "./pages/Performance";
import HistoryPage from "./pages/History";
import StrategyPage from "./pages/Strategy";
import ExchangesPage from "./pages/Exchanges";
import ActivityPage from "./pages/Activity";
import SettingsPage from "./pages/Settings";

export default function App() {
  return (
    <AppProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="scanner" element={<ScannerPage />} />
          <Route path="feed" element={<FeedPage />} />
          <Route path="positions" element={<PositionsPage />} />
          <Route path="performance" element={<PerformancePage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="strategy" element={<StrategyPage />} />
          <Route path="exchanges" element={<ExchangesPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppProvider>
  );
}
