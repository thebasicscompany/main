import {
  ClipboardCheck,
  ClipboardCheckSolid,
  Cog,
  CogSolid,
  FileSearch,
  FileSearchSolid,
  Globe,
  GlobeSolid,
  Home,
  HomeSolid,
  MessageSquare,
  MessageSquareSolid,
  Play,
  PlaySolid,
  Workflow,
  WorkflowSolid,
  type Icon,
} from "@/icons";

import { conversationThreads } from "@/mocks/conversations";

export interface NavSubItem {
  title: string;
  url: string;
  icon?: Icon;
  iconActive?: Icon;
  comingSoon?: boolean;
  newTab?: boolean;
  isNew?: boolean;
}

export interface NavMainItem {
  title: string;
  url: string;
  icon?: Icon;
  iconActive?: Icon;
  subItems?: NavSubItem[];
  comingSoon?: boolean;
  newTab?: boolean;
  isNew?: boolean;
}

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    items: [
      { title: "Home", url: "/", icon: Home, iconActive: HomeSolid },
      { title: "Runs", url: "/runs", icon: Play, iconActive: PlaySolid },
      { title: "Workflows", url: "/workflows", icon: Workflow, iconActive: WorkflowSolid },
      { title: "Approvals", url: "/approvals", icon: ClipboardCheck, iconActive: ClipboardCheckSolid },
    ],
  },
  {
    id: 2,
    label: "Workspace",
    items: [
      { title: "Context", url: "/context", icon: Globe, iconActive: GlobeSolid },
      { title: "Audit", url: "/audit", icon: FileSearch, iconActive: FileSearchSolid },
      {
        title: "Conversations",
        url: "/conversations",
        icon: MessageSquare,
        iconActive: MessageSquareSolid,
        subItems: [
          ...conversationThreads.map((t) => ({
            title: t.title,
            url: `/conversations/${t.id}`,
          })),
          { title: "Browse all", url: "/conversations" },
        ],
      },
    ],
  },
  {
    id: 3,
    items: [{ title: "Settings", url: "/settings", icon: Cog, iconActive: CogSolid }],
  },
];
