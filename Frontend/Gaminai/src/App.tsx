import { BrowserRouter, Route, Routes } from 'react-router';
import AuthPage from './Pages/AuthPage';
import ChatPage from './Pages/ChatPage';

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/" element={<ChatPage />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
