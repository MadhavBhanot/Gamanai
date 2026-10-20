import { BrowserRouter, Route, Routes } from 'react-router';
import { Analytics } from '@vercel/analytics/react';
import AdminPage from './Pages/AdminPage';
import AuthPage from './Pages/AuthPage';
import ChatPage from './Pages/ChatPage';
import EvalsPage from './Pages/EvalsPage';

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/" element={<ChatPage />} />
        <Route path="/evals" element={<EvalsPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
      <Analytics />
    </BrowserRouter>
  );
};

export default App;
