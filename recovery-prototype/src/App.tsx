import { AdminClientDetail, AddClientScreen, ClientListScreen } from './admin/ClientList';
import { CaseReviewScreen } from './admin/CaseReview';
import { ControlRoomScreen } from './admin/ControlRoom';
import { AddProspectScreen } from './client/AddProspect';
import { AddResponseScreen } from './client/AddResponse';
import { ClientCaseScreen } from './client/ClientCaseScreen';
import { ClientDashboard } from './client/ClientDashboard';
import { LoginScreen } from './client/LoginScreen';
import { OutcomeScreen } from './client/OutcomeScreen';
import { SentConfirmationScreen } from './client/SentConfirmation';
import { SubmittedScreen } from './client/SubmittedScreen';
import { DemoBar } from './components/DemoBar';
import { useRoute } from './router';

export function App() {
  const route = useRoute();
  const role = route.name === 'login' ? 'none' : route.name.startsWith('admin') ? 'admin' : 'client';

  let screen;
  switch (route.name) {
    case 'login': screen = <LoginScreen />; break;
    case 'client-dashboard': screen = <ClientDashboard />; break;
    case 'client-new': screen = <AddProspectScreen />; break;
    case 'client-submitted': screen = <SubmittedScreen id={route.id} />; break;
    case 'client-case': screen = <ClientCaseScreen id={route.id} />; break;
    case 'client-sent': screen = <SentConfirmationScreen id={route.id} />; break;
    case 'client-respond': screen = <AddResponseScreen id={route.id} />; break;
    case 'client-outcome': screen = <OutcomeScreen id={route.id} />; break;
    case 'admin-home': screen = <ControlRoomScreen />; break;
    case 'admin-case': screen = <CaseReviewScreen id={route.id} />; break;
    case 'admin-clients': screen = <ClientListScreen />; break;
    case 'admin-client': screen = <AdminClientDetail id={route.id} />; break;
    case 'admin-client-new': screen = <AddClientScreen />; break;
  }

  return (
    <div className={`app app-${role}`}>
      <DemoBar role={role} />
      <main className="main">{screen}</main>
    </div>
  );
}
