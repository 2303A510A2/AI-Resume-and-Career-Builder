import { Routes, Route, Navigate } from 'react-router-dom';
import PublicLayout from './components/PublicLayout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import AdminRoute from './components/AdminRoute.jsx';
import DashboardLayout from './components/DashboardLayout.jsx';
import { useAuth } from './hooks/useAuth';

import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import VerifyOTP from './pages/VerifyOTP.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import AdminLogin from './pages/AdminLogin.jsx';

import Dashboard from './pages/Dashboard.jsx';
import Resume from './pages/Resume.jsx';
import JobDescription from './pages/JobDescription.jsx';
import SkillGap from './pages/SkillGap.jsx';
import CareerAssistant from './pages/CareerAssistant.jsx';
import InterviewPreparation from './pages/InterviewPreparation.jsx';
import MockInterview from './pages/MockInterview.jsx';
import LearningRoadmap from './pages/LearningRoadmap.jsx';
import ResumeImprover from './pages/ResumeImprover.jsx';
import CodingPreparation from './pages/CodingPreparation.jsx';
import Profile from './pages/Profile.jsx';
import Settings from './pages/Settings.jsx';
import NotFound from './pages/NotFound.jsx';

import AdminLayout from './pages/admin/AdminLayout.jsx';
import AdminOverview from './pages/admin/AdminOverview.jsx';
import AdminUsers from './pages/admin/AdminUsers.jsx';
import AdminRequests from './pages/admin/AdminRequests.jsx';
import AdminCoAdmins from './pages/admin/AdminCoAdmins.jsx';
import AdminControls from './pages/admin/AdminControls.jsx';
import AdminAudit from './pages/admin/AdminAudit.jsx';
import AdminSettings from './pages/admin/AdminSettings.jsx';

// Client-side convenience gate for admin sections. The BACKEND is the real
// authority (it 403s regardless); this only avoids firing a doomed request and
// shows a clean message when a link is opened directly.
function AdminSection({ perm = '', mainOnly = false, children }) {
  const { admin } = useAuth();
  const allowed = mainOnly
    ? admin?.role === 'main_admin'
    : admin?.role === 'main_admin' || admin?.adminPermissions?.[perm] === true;
  if (!allowed) {
    return <div className="inline-note warn">You do not have access to this section.</div>;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      {/* The React SPA's own HTML entry. In development Vite serves this file at
          /react-app.html (the build ships it under the same name), so without
          this route the documented dev URL rendered the 404 page instead of the
          app. Sending it to "/" makes that entry point work like every other. */}
      <Route path="/react-app.html" element={<Navigate to="/" replace />} />

      {/* Public routes */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/verify-otp" element={<VerifyOTP />} />
        <Route path="/reset-password" element={<ResetPassword />} />
      </Route>

      <Route path="/admin/login" element={<AdminLogin />} />

      {/* User dashboard (sidebar layout) */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        {/* Main page is the ChatGPT-style conversation by default */}
        <Route index element={<CareerAssistant />} />
        <Route path="overview" element={<Dashboard />} />
        <Route path="resume" element={<Resume />} />
        <Route path="job-description" element={<JobDescription />} />
        <Route path="skill-gap" element={<SkillGap />} />
        <Route path="career-assistant" element={<CareerAssistant />} />
        <Route path="interview" element={<InterviewPreparation />} />
        <Route path="mock-interview" element={<MockInterview />} />
        <Route path="roadmap" element={<LearningRoadmap />} />
        <Route path="resume-improver" element={<ResumeImprover />} />
        <Route path="coding-prep" element={<CodingPreparation />} />
        <Route path="profile" element={<Profile />} />
        <Route path="settings" element={<Settings />} />
      </Route>

      {/* Admin portal (sidebar layout, forced-password gate inside the layout) */}
      <Route
        path="/admin"
        element={
          <AdminRoute>
            <AdminLayout />
          </AdminRoute>
        }
      >
        <Route index element={<Navigate to="/admin/overview" replace />} />
        <Route path="overview" element={<AdminOverview />} />
        <Route path="users" element={<AdminSection perm="manageUsers"><AdminUsers /></AdminSection>} />
        <Route path="controls" element={<AdminSection mainOnly><AdminControls /></AdminSection>} />
        <Route path="requests" element={<AdminSection mainOnly><AdminRequests /></AdminSection>} />
        <Route path="co-admins" element={<AdminSection mainOnly><AdminCoAdmins /></AdminSection>} />
        <Route path="audit" element={<AdminSection perm="viewAudit"><AdminAudit /></AdminSection>} />
        <Route path="settings" element={<AdminSettings />} />
        {/* Back-compat: paths from the previous design now live under Settings. */}
        <Route path="account" element={<Navigate to="/admin/settings" replace />} />
        <Route path="monitoring" element={<Navigate to="/admin/settings" replace />} />
        <Route path="dashboard" element={<Navigate to="/admin/overview" replace />} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
