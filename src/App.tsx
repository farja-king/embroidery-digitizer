import { StoreProvider } from './state/store';
import HeaderBar from './components/HeaderBar';
import Toolbar from './components/Toolbar';
import Canvas from './components/Canvas';
import ObjectsPanel from './components/ObjectsPanel';
import PropertiesPanel from './components/PropertiesPanel';
import './App.css';

function App() {
  return (
    <StoreProvider>
      <div className="app">
        <HeaderBar />
        <div className="app-body">
          <Toolbar />
          <Canvas />
          <div className="sidebar">
            <ObjectsPanel />
            <PropertiesPanel />
          </div>
        </div>
      </div>
    </StoreProvider>
  );
}

export default App;
