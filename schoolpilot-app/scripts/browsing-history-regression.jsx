import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { queryClient } from '../src/lib/queryClient';
import { AuthProvider } from '../src/contexts/AuthContext';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import StudentDetailDrawer from '../src/products/classpilot/components/StudentDetailDrawer';
import '../src/index.css';
createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><AuthProvider><ThemeProvider><BrowserRouter><StudentDetailDrawer student={{studentId:'student-a',studentName:'Sample Student',activeTabTitle:'Classroom',activeTabUrl:'https://classroom.google.com'}} urlHistory={[]} allowedDomains={[]} onClose={()=>{}} /></BrowserRouter></ThemeProvider></AuthProvider></QueryClientProvider>);
