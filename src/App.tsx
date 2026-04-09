import { useState, useRef, useEffect, Component, ErrorInfo, ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Send, 
  SendHorizontal,
  Bot, 
  User as UserIcon, 
  Trash2, 
  Plus, 
  Sparkles,
  Loader2,
  ChevronRight,
  MessageSquare,
  Info,
  MoreVertical,
  LogIn,
  LogOut,
  AlertCircle,
  Image as ImageIcon,
  Download
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { sendMessageStream, generateImage, ChatMessage } from "@/src/services/geminiService";
import { cn } from "@/lib/utils";
import { 
  auth, 
  db, 
  signInWithGoogle, 
  logout, 
  handleFirestoreError, 
  OperationType 
} from "./firebase";
import { 
  onAuthStateChanged, 
  User 
} from "firebase/auth";
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp,
  getDocs
} from "firebase/firestore";

// Error Boundary Component
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "Something went wrong.";
      try {
        const firestoreError = JSON.parse(this.state.error?.message || "{}");
        if (firestoreError.error) {
          errorMessage = `Database Error: ${firestoreError.error}`;
        }
      } catch {
        errorMessage = this.state.error?.message || errorMessage;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4 bg-red-50 text-red-900">
          <AlertCircle className="w-12 h-12 mb-4" />
          <h1 className="text-xl font-bold mb-2">Application Error</h1>
          <p className="text-sm text-center max-w-md mb-6">{errorMessage}</p>
          <Button onClick={() => window.location.reload()} variant="destructive">
            Reload Application
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

const STORAGE_KEY = "red_chat_history";
const DRAFT_KEY = "red_chat_draft";

export default function App() {
  return (
    <ErrorBoundary>
      <ChatApp />
    </ErrorBoundary>
  );
}

function ChatApp() {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [streamingMessage, setStreamingMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auth Listener
  useEffect(() => {
    // Load draft on mount
    const savedDraft = localStorage.getItem(DRAFT_KEY);
    if (savedDraft) setInput(savedDraft);

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      
      if (currentUser) {
        // Ensure user document exists
        const userRef = doc(db, "users", currentUser.uid);
        try {
          const userDoc = await getDoc(userRef);
          if (!userDoc.exists()) {
            await setDoc(userRef, {
              uid: currentUser.uid,
              email: currentUser.email,
              displayName: currentUser.displayName,
              photoURL: currentUser.photoURL,
              createdAt: new Date().toISOString()
            });
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `users/${currentUser.uid}`);
        }
      } else {
        setConversations([]);
        setActiveId(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Firestore Real-time Sync
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const conversationsRef = collection(db, "users", user.uid, "conversations");
    const q = query(conversationsRef, orderBy("updatedAt", "desc"));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedConversations: Conversation[] = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Conversation));
      
      setConversations(fetchedConversations);
      
      // If no active ID but we have conversations, set the first one
      if (!activeId && fetchedConversations.length > 0) {
        setActiveId(fetchedConversations[0].id);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/conversations`);
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  // Messages Sync
  useEffect(() => {
    if (!user || !activeId || !isAuthReady) return;

    const messagesRef = collection(db, "users", user.uid, "conversations", activeId, "messages");
    const q = query(messagesRef, orderBy("timestamp", "asc"));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedMessages = snapshot.docs.map(doc => doc.data() as ChatMessage);
      setConversations(prev => prev.map(c => {
        if (c.id === activeId) {
          return { ...c, messages: fetchedMessages };
        }
        return c;
      }));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `users/${user.uid}/conversations/${activeId}/messages`);
    });

    return () => unsubscribe();
  }, [user, activeId, isAuthReady]);

  // Save history whenever it changes
  useEffect(() => {
    if (conversations.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [conversations]);

  // Save draft input and handle page visibility/unload
  useEffect(() => {
    const saveDraft = () => {
      localStorage.setItem(DRAFT_KEY, input);
    };

    const timeoutId = setTimeout(saveDraft, 500); // Debounced save

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveDraft();
      }
    };

    const handleBeforeUnload = () => {
      saveDraft();
    };

    window.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [input]);

  const activeConversation = conversations.find(c => c.id === activeId);
  const messages = activeConversation?.messages || [];

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingMessage]);

  const handleGenerateImage = async () => {
    if (!input.trim() || isLoading) return;

    const prompt = input;
    let currentId = activeId;
    let currentConversations = [...conversations];

    // Create a new conversation if none is active
    if (!currentId) {
      if (user) {
        try {
          const conversationsRef = collection(db, "users", user.uid, "conversations");
          const newDoc = await addDoc(conversationsRef, {
            userId: user.uid,
            title: "Image: " + prompt.slice(0, 20) + (prompt.length > 20 ? "..." : ""),
            updatedAt: Date.now(),
            createdAt: Date.now()
          });
          currentId = newDoc.id;
          setActiveId(currentId);
        } catch (error) {
          handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/conversations`);
          return;
        }
      } else {
        const newId = Date.now().toString();
        const newConv: Conversation = {
          id: newId,
          title: "Image: " + prompt.slice(0, 20) + (prompt.length > 20 ? "..." : ""),
          messages: [],
          updatedAt: Date.now()
        };
        currentConversations = [newConv, ...currentConversations];
        setConversations(currentConversations);
        setActiveId(newId);
        currentId = newId;
      }
    }

    const userMessage: ChatMessage = { 
      role: "user", 
      content: prompt,
      timestamp: Date.now()
    };
    
    if (user && currentId) {
      try {
        const messagesRef = collection(db, "users", user.uid, "conversations", currentId, "messages");
        await addDoc(messagesRef, userMessage);
        const convRef = doc(db, "users", user.uid, "conversations", currentId);
        await updateDoc(convRef, { updatedAt: Date.now() });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/conversations/${currentId}/messages`);
      }
    } else {
      const updatedConversations = currentConversations.map(c => {
        if (c.id === currentId) {
          return {
            ...c,
            messages: [...c.messages, userMessage],
            updatedAt: Date.now()
          };
        }
        return c;
      });
      setConversations(updatedConversations);
    }
    
    setInput("");
    localStorage.removeItem(DRAFT_KEY);
    if (textareaRef.current) {
      textareaRef.current.style.height = '80px';
    }
    setIsLoading(true);
    setStreamingMessage("Generating image...");

    try {
      const imageUrl = await generateImage(prompt);
      
      const assistantMessage: ChatMessage = { 
        role: "model", 
        content: imageUrl,
        type: "image",
        timestamp: Date.now()
      };

      if (user && currentId) {
        const messagesRef = collection(db, "users", user.uid, "conversations", currentId, "messages");
        await addDoc(messagesRef, assistantMessage);
      } else {
        setConversations(prev => prev.map(c => {
          if (c.id === currentId) {
            return {
              ...c,
              messages: [...c.messages, assistantMessage],
              updatedAt: Date.now()
            };
          }
          return c;
        }));
      }
    } catch (error) {
      console.error("Image generation failed:", error);
      const errorMessage: ChatMessage = {
        role: "model",
        content: "I'm sorry, I failed to generate the image. Please try again with a different prompt.",
        timestamp: Date.now()
      };
      if (user && currentId) {
        const messagesRef = collection(db, "users", user.uid, "conversations", currentId, "messages");
        await addDoc(messagesRef, errorMessage);
      } else {
        setConversations(prev => prev.map(c => {
          if (c.id === currentId) {
            return {
              ...c,
              messages: [...c.messages, errorMessage],
              updatedAt: Date.now()
            };
          }
          return c;
        }));
      }
    } finally {
      setIsLoading(false);
      setStreamingMessage("");
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    let currentId = activeId;
    let currentConversations = [...conversations];

    // Create a new conversation if none is active
    if (!currentId) {
      if (user) {
        try {
          const conversationsRef = collection(db, "users", user.uid, "conversations");
          const newDoc = await addDoc(conversationsRef, {
            userId: user.uid,
            title: input.slice(0, 30) + (input.length > 30 ? "..." : ""),
            updatedAt: Date.now(),
            createdAt: Date.now()
          });
          currentId = newDoc.id;
          setActiveId(currentId);
        } catch (error) {
          handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/conversations`);
          return;
        }
      } else {
        const newId = Date.now().toString();
        const newConv: Conversation = {
          id: newId,
          title: input.slice(0, 30) + (input.length > 30 ? "..." : ""),
          messages: [],
          updatedAt: Date.now()
        };
        currentConversations = [newConv, ...currentConversations];
        setConversations(currentConversations);
        setActiveId(newId);
        currentId = newId;
      }
    }

    const userMessage: ChatMessage = { 
      role: "user", 
      content: input,
      timestamp: Date.now()
    };
    
    if (user && currentId) {
      try {
        const messagesRef = collection(db, "users", user.uid, "conversations", currentId, "messages");
        await addDoc(messagesRef, userMessage);
        const convRef = doc(db, "users", user.uid, "conversations", currentId);
        await updateDoc(convRef, { updatedAt: Date.now() });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/conversations/${currentId}/messages`);
      }
    } else {
      const updatedConversations = currentConversations.map(c => {
        if (c.id === currentId) {
          return {
            ...c,
            messages: [...c.messages, userMessage],
            updatedAt: Date.now()
          };
        }
        return c;
      });
      setConversations(updatedConversations);
    }
    
    setInput("");
    localStorage.removeItem(DRAFT_KEY);
    if (textareaRef.current) {
      textareaRef.current.style.height = '80px';
    }
    setIsLoading(true);
    setStreamingMessage("");

    try {
      const activeConv = conversations.find(c => c.id === currentId);
      const history = activeConv?.messages || [];
      let fullResponse = "";
      
      const stream = sendMessageStream(input, history);
      
      for await (const chunk of stream) {
        fullResponse += chunk;
        setStreamingMessage(fullResponse);
      }

      const botMessage: ChatMessage = { 
        role: "model", 
        content: fullResponse,
        timestamp: Date.now()
      };

      if (user && currentId) {
        const messagesRef = collection(db, "users", user.uid, "conversations", currentId, "messages");
        await addDoc(messagesRef, botMessage);
        const convRef = doc(db, "users", user.uid, "conversations", currentId);
        await updateDoc(convRef, { updatedAt: Date.now() });
      } else {
        setConversations(prev => prev.map(c => {
          if (c.id === currentId) {
            return {
              ...c,
              messages: [...c.messages, botMessage],
              updatedAt: Date.now()
            };
          }
          return c;
        }));
      }
      setStreamingMessage("");
    } catch (error) {
      console.error("Failed to send message:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const createNewChat = async () => {
    if (user) {
      try {
        const conversationsRef = collection(db, "users", user.uid, "conversations");
        const newDoc = await addDoc(conversationsRef, {
          userId: user.uid,
          title: "New Chat",
          updatedAt: Date.now(),
          createdAt: Date.now()
        });
        setActiveId(newDoc.id);
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, `users/${user.uid}/conversations`);
      }
    } else {
      const newId = Date.now().toString();
      const newConv: Conversation = {
        id: newId,
        title: "New Chat",
        messages: [],
        updatedAt: Date.now()
      };
      setConversations([newConv, ...conversations]);
      setActiveId(newId);
    }
    setStreamingMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = '80px';
    }
  };

  const deleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (user) {
      try {
        const convRef = doc(db, "users", user.uid, "conversations", id);
        await deleteDoc(convRef);
        if (activeId === id) setActiveId(null);
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `users/${user.uid}/conversations/${id}`);
      }
    } else {
      const updated = conversations.filter(c => c.id !== id);
      setConversations(updated);
      if (activeId === id) {
        setActiveId(updated.length > 0 ? updated[0].id : null);
      }
    }
  };

  return (
    <div className="flex h-screen w-full bg-zinc-50 font-sans text-zinc-900 overflow-hidden relative">
      {/* Mobile Menu Trigger - Left Middle */}
      <div className="md:hidden fixed left-0 top-1/2 -translate-y-1/2 z-50">
        <Button
          variant="secondary"
          size="icon"
          className="h-12 w-6 rounded-l-none rounded-r-xl bg-white border border-l-0 border-zinc-200 shadow-md hover:bg-red-50 hover:text-red-600 transition-all group"
          onClick={() => setIsMobileMenuOpen(true)}
        >
          <ChevronRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
        </Button>
      </div>

      {/* Mobile Drawer Overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-black/20 backdrop-blur-sm z-[60] md:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 left-0 w-72 bg-white border-r border-zinc-200 p-4 z-[70] md:hidden flex flex-col"
            >
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-2 px-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-white">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <h1 className="text-xl font-bold tracking-tight">RED Chat</h1>
                </div>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-8 w-8 text-zinc-400"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <Plus className="h-4 w-4 rotate-45" />
                </Button>
              </div>

              <Button 
                onClick={() => {
                  createNewChat();
                  setIsMobileMenuOpen(false);
                }}
                variant="outline" 
                className="mb-6 justify-start gap-2 border-zinc-200 hover:bg-zinc-50"
              >
                <Plus className="h-4 w-4" />
                New Chat
              </Button>

              <div className="flex-1 overflow-y-auto space-y-1 custom-scrollbar pr-2">
                <div className="px-2 py-2 text-[10px] font-bold text-zinc-400 uppercase tracking-[0.2em] mb-2">
                  Session History
                </div>
                {conversations.length === 0 ? (
                  <div className="px-2 py-4 text-sm text-zinc-400 italic">
                    No history yet...
                  </div>
                ) : (
                  conversations.map((conv) => (
                    <div 
                      key={conv.id}
                      onClick={() => {
                        setActiveId(conv.id);
                        setIsMobileMenuOpen(false);
                      }}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                        activeId === conv.id ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
                      )}
                    >
                      <MessageSquare className="h-4 w-4 shrink-0 opacity-70" />
                      <span className="truncate flex-1">{conv.title}</span>
                      <button 
                        onClick={(e) => deleteChat(conv.id, e)}
                        className="p-1 hover:bg-zinc-200 rounded transition-all"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-zinc-400 hover:text-red-500" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="mt-auto pt-4 border-t border-zinc-100">
                {user ? (
                  <div className="flex items-center gap-3 px-2 py-3 rounded-xl hover:bg-zinc-50 transition-colors group">
                    <Avatar className="h-9 w-9 border-2 border-white shadow-sm">
                      <AvatarImage src={user.photoURL || ""} />
                      <AvatarFallback className="bg-red-100 text-red-600 text-xs">
                        {user.displayName?.charAt(0) || user.email?.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 truncate">{user.displayName || "User"}</p>
                      <p className="text-[10px] text-zinc-500 truncate">{user.email}</p>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-zinc-400 hover:text-red-600"
                      onClick={() => logout()}
                    >
                      <LogOut className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button 
                    variant="outline" 
                    className="w-full justify-start gap-2 border-zinc-200 hover:bg-red-50 hover:text-red-600 hover:border-red-100 transition-all"
                    onClick={() => signInWithGoogle()}
                  >
                    <LogIn className="h-4 w-4" />
                    Sign In with Google
                  </Button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex w-72 flex-col border-r border-zinc-200 bg-white p-4 relative z-10">
        <div className="flex items-center gap-2 px-2 mb-8">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-600 text-white shadow-lg shadow-red-200">
            <Sparkles className="h-5 w-5" />
          </div>
          <h1 className="text-2xl font-display font-bold tracking-tight text-zinc-900">RED <span className="text-red-600">AI</span></h1>
        </div>

        <Button 
          onClick={createNewChat}
          variant="outline" 
          className="mb-6 justify-start gap-2 border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 transition-all font-medium"
        >
          <Plus className="h-4 w-4" />
          New Session
        </Button>

        <div className="flex-1 overflow-y-auto space-y-1 custom-scrollbar pr-2">
          <div className="px-2 py-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Recent Chats
          </div>
          {conversations.length === 0 ? (
            <div className="px-2 py-4 text-sm text-zinc-400 italic">
              No history yet...
            </div>
          ) : (
            conversations.map((conv) => (
              <div 
                key={conv.id}
                onClick={() => setActiveId(conv.id)}
                className={cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                  activeId === conv.id ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
                )}
              >
                <MessageSquare className="h-4 w-4 shrink-0 opacity-70" />
                <span className="truncate flex-1">{conv.title}</span>
                <button 
                  onClick={(e) => deleteChat(conv.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-zinc-200 rounded transition-all"
                >
                  <Trash2 className="h-3.5 w-3.5 text-zinc-400 hover:text-red-500" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="mt-auto pt-4 border-t border-zinc-100">
          {user ? (
            <div className="flex items-center gap-3 px-2 py-3 rounded-xl hover:bg-zinc-50 transition-colors group">
              <Avatar className="h-9 w-9 border-2 border-white shadow-sm">
                <AvatarImage src={user.photoURL || ""} />
                <AvatarFallback className="bg-red-100 text-red-600 text-xs">
                  {user.displayName?.charAt(0) || user.email?.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-900 truncate">{user.displayName || "User"}</p>
                <p className="text-[10px] text-zinc-500 truncate">{user.email}</p>
              </div>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 text-zinc-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => logout()}
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Button 
              variant="outline" 
              className="w-full justify-start gap-2 border-zinc-200 hover:bg-red-50 hover:text-red-600 hover:border-red-100 transition-all"
              onClick={() => signInWithGoogle()}
            >
              <LogIn className="h-4 w-4" />
              Sign In with Google
            </Button>
          )}
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col bg-white md:bg-zinc-50/30 overflow-hidden">
        {/* Header */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-zinc-200 bg-white/80 backdrop-blur-md px-6 z-10">
          <div className="flex items-center gap-3">
            <div className="md:hidden flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-white mr-2 shadow-lg shadow-red-100">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-display font-bold tracking-tight text-zinc-900">RED <span className="text-red-600">AI</span></h2>
                <Badge variant="secondary" className="text-[9px] h-3.5 px-1 bg-red-50 text-red-600 border-none font-mono font-bold tracking-widest">
                  CORE-V3
                </Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-1 w-1 rounded-full bg-green-500 animate-pulse" />
                <p className="text-[9px] font-mono font-medium text-zinc-400 uppercase tracking-wider">System Operational</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-all">
              <Info className="h-4 w-4" />
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-8 w-8 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-all md:hidden" 
              onClick={createNewChat}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Messages Container */}
        <div className="flex-1 overflow-y-auto scroll-smooth custom-scrollbar">
          <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-8 min-h-full flex flex-col">
            {messages.length === 0 && !streamingMessage && (
              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex-1 flex flex-col items-center justify-center py-12 text-center"
              >
                <div className="h-16 w-16 rounded-2xl bg-red-600 flex items-center justify-center text-white mb-6 shadow-xl shadow-red-100">
                  <Sparkles className="h-8 w-8" />
                </div>
                <h3 className="text-2xl font-bold tracking-tight mb-2">How can I help you today?</h3>
                <p className="text-zinc-500 max-w-sm mb-8">
                  I'm your AI assistant, ready to help with coding, writing, brainstorming, or just answering questions.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-md">
                  {[
                    "Explain quantum computing",
                    "Write a poem about rain",
                    "Help me plan a trip to Tokyo",
                    "How do I use React hooks?"
                  ].map((suggestion) => (
                    <Button 
                      key={suggestion}
                      variant="outline" 
                      className="justify-start h-auto py-3 px-4 text-left text-xs border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 transition-all"
                      onClick={() => {
                        setInput(suggestion);
                        if (textareaRef.current) {
                          textareaRef.current.focus();
                          // Small delay to allow state update or just set height manually
                          setTimeout(() => {
                            if (textareaRef.current) {
                              textareaRef.current.style.height = 'auto';
                              textareaRef.current.style.height = Math.max(80, Math.min(textareaRef.current.scrollHeight, 192)) + 'px';
                            }
                          }, 0);
                        }
                      }}
                    >
                      {suggestion}
                      <ChevronRight className="ml-auto h-3 w-3 opacity-30" />
                    </Button>
                  ))}
                </div>
              </motion.div>
            )}

            <div className="space-y-8 flex-1">
              <AnimatePresence initial={false}>
                {messages.map((msg, idx) => (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      "flex gap-4 md:gap-6",
                      msg.role === "user" ? "flex-row-reverse" : "flex-row"
                    )}
                  >
                    <div className={cn(
                      "flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg border shadow-sm",
                      msg.role === "user" 
                        ? "bg-white border-zinc-200 text-zinc-900" 
                        : "bg-red-600 border-red-500 text-white"
                    )}>
                      {msg.role === "user" ? <UserIcon className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                    </div>
                    <div className={cn(
                      "flex flex-col gap-1.5 max-w-[85%] md:max-w-[75%]",
                      msg.role === "user" ? "items-end" : "items-start"
                    )}>
                      <div className={cn(
                        "px-4 py-3 rounded-2xl text-sm shadow-sm transition-all duration-300",
                        msg.role === "user" 
                          ? "bg-red-600 text-white rounded-tr-none shadow-red-100/50" 
                          : "tech-card bg-white text-zinc-900 rounded-tl-none border-zinc-200"
                      )}>
                        {msg.type === "image" ? (
                          <div className="space-y-2">
                            <img 
                              src={msg.content} 
                              alt="Generated AI" 
                              className="rounded-lg max-w-full h-auto shadow-md border border-zinc-100"
                              referrerPolicy="no-referrer"
                            />
                            <div className="flex justify-end">
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-7 px-2 text-[10px] font-mono uppercase tracking-wider gap-1.5 text-zinc-500 hover:text-red-600 hover:bg-red-50"
                                onClick={() => {
                                  const link = document.createElement('a');
                                  link.href = msg.content;
                                  link.download = `red-ai-gen-${Date.now()}.png`;
                                  link.click();
                                }}
                              >
                                <Download className="h-3 w-3" />
                                Download
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                      <div className={cn(
                        "flex items-center gap-2 px-1 text-[9px] font-mono font-bold uppercase tracking-widest",
                        msg.role === "user" ? "text-red-400" : "text-zinc-400"
                      )}>
                        <span>{msg.role === "user" ? "User" : "RED AI"}</span>
                        <span className="h-0.5 w-0.5 rounded-full bg-current opacity-30" />
                        <span>{msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Just now"}</span>
                      </div>
                    </div>
                  </motion.div>
                ))}

                {streamingMessage && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex gap-4 md:gap-6"
                  >
                    <div className="flex h-8 w-8 shrink-0 select-none items-center justify-center rounded-lg border bg-red-600 border-red-500 text-white shadow-sm">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1.5 max-w-[85%] md:max-w-[75%] items-start">
                      <div className="tech-card px-4 py-3 rounded-2xl text-sm bg-white text-zinc-900 rounded-tl-none shadow-sm border-zinc-200">
                        <div className="markdown-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {streamingMessage}
                          </ReactMarkdown>
                          <span className="inline-block w-1.5 h-4 bg-red-500/50 animate-pulse ml-1 align-middle" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 px-1 text-[9px] font-mono font-bold uppercase tracking-widest text-red-500">
                        <span>Processing</span>
                        <div className="flex gap-0.5">
                          <span className="h-0.5 w-0.5 rounded-full bg-current animate-bounce" />
                          <span className="h-0.5 w-0.5 rounded-full bg-current animate-bounce [animation-delay:0.2s]" />
                          <span className="h-0.5 w-0.5 rounded-full bg-current animate-bounce [animation-delay:0.4s]" />
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div ref={scrollRef} className="h-4 shrink-0" />
          </div>
        </div>

        {/* Input Area */}
        <div className="shrink-0 p-4 md:p-6 bg-white/50 backdrop-blur-sm border-t border-zinc-100">
          <div className="max-w-5xl mx-auto relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-red-500 to-red-600 rounded-2xl blur opacity-10 group-focus-within:opacity-25 transition duration-500"></div>
            <Card className="tech-card relative flex items-end gap-2 p-2 rounded-2xl border-zinc-200 shadow-xl bg-white">
              <div className="flex-1 min-h-[80px] flex items-center px-2 relative">
                <div className="absolute left-2 bottom-3 flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-all"
                    onClick={handleGenerateImage}
                    disabled={!input.trim() || isLoading}
                    title="Generate Image"
                  >
                    <ImageIcon className="h-4 w-4" />
                  </Button>
                </div>
                <textarea
                  ref={textareaRef}
                  placeholder="Initiate command or describe an image..."
                  className="w-[320px] h-[80px] bg-transparent border-none focus:ring-0 resize-none py-3 pl-10 text-sm max-h-48 scrollbar-hide outline-none font-sans"
                  rows={1}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.max(80, Math.min(e.target.scrollHeight, 192)) + 'px';
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                />
                {input.trim() && (
                  <div className="absolute top-1 right-2 text-[9px] font-mono font-bold text-red-500 uppercase tracking-[0.2em] opacity-0 group-focus-within:opacity-100 transition-opacity pointer-events-none">
                    Buffer Synced
                  </div>
                )}
              </div>
              <Button 
                size="icon" 
                className={cn(
                  "h-10 w-10 rounded-xl transition-all duration-300 shrink-0 shadow-lg",
                  input.trim() ? "bg-red-600 hover:bg-red-700 text-white shadow-red-100" : "bg-zinc-100 text-zinc-400 cursor-not-allowed"
                )}
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
              >
                {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <SendHorizontal className="h-5 w-5" />}
              </Button>
            </Card>
            <p className="text-[9px] font-mono font-medium text-zinc-400 text-center mt-3 uppercase tracking-widest">
              RED CORE V3.0.4 • AI Output may vary
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
