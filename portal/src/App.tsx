import { Navigate, Route, Routes } from "react-router";
import { SessionProvider, useSession } from "./session";
import { Layout } from "./Layout";
import { SignIn } from "./pages/SignIn";
import { Environments } from "./pages/Environments";
import { Control } from "./pages/Control";
import { CatalogPage } from "./pages/Catalog";
import { Validate } from "./pages/Validate";
import { Health } from "./pages/Health";
import { NewEnvironment } from "./pages/NewEnvironment";

function SignedIn({ children }: { children: React.ReactNode }) {
  const { person, checked } = useSession();
  if (!checked) return null;
  if (!person) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route element={<SignedIn><Layout /></SignedIn>}>
          <Route index element={<Environments />} />
          <Route path="environments/:key" element={<Control />} />
          <Route path="new" element={<NewEnvironment />} />
          <Route path="validate" element={<Validate />} />
          <Route path="catalog" element={<CatalogPage />} />
          <Route path="health" element={<Health />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
