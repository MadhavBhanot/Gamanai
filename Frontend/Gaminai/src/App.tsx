import { BrowserRouter, Route, Routes } from 'react-router';
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
      </Routes>
    </BrowserRouter>
  );
};

export default App;
