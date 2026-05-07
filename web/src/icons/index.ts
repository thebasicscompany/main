/**
 * Application icons — [Heroicons](https://heroicons.com/) v2 **outline** (24×24) by default;
 * **solid** aliases (`*Solid`) are exported for active sidebar states.
 * Import only from `@/icons` so we can change vendors or variants in one place.
 */
import type { ComponentType, SVGProps } from "react";

import {
  ArrowPathIcon,
  ArrowRightStartOnRectangleIcon,
  ArrowsPointingOutIcon,
  ArrowsUpDownIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpIcon,
  Bars3Icon,
  BellIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  ChatBubbleLeftEllipsisIcon,
  ChatBubbleLeftRightIcon,
  CheckBadgeIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClipboardDocumentCheckIcon,
  ClockIcon,
  CodeBracketIcon,
  Cog6ToothIcon,
  CommandLineIcon,
  ComputerDesktopIcon,
  CreditCardIcon,
  CursorArrowRippleIcon,
  DocumentCheckIcon,
  DocumentDuplicateIcon,
  DocumentMagnifyingGlassIcon,
  EllipsisHorizontalIcon,
  EllipsisVerticalIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  FolderIcon,
  ForwardIcon,
  GlobeAltIcon,
  HandRaisedIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  HomeIcon,
  InformationCircleIcon,
  KeyIcon,
  LightBulbIcon,
  LinkIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  MinusIcon,
  PaperClipIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  ShieldCheckIcon,
  StopIcon,
  TrashIcon,
  UserCircleIcon,
  WrenchIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

import {
  ChatBubbleLeftRightIcon as ChatBubbleLeftRightIconSolid,
  ClipboardDocumentCheckIcon as ClipboardDocumentCheckIconSolid,
  Cog6ToothIcon as Cog6ToothIconSolid,
  CommandLineIcon as CommandLineIconSolid,
  DocumentMagnifyingGlassIcon as DocumentMagnifyingGlassIconSolid,
  GlobeAltIcon as GlobeAltIconSolid,
  HomeIcon as HomeIconSolid,
  PlayIcon as PlayIconSolid,
} from "@heroicons/react/24/solid";

/** Shared icon component type (sidebar, placeholders, menus). */
export type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** @deprecated Use `Icon` */
export type LucideIcon = Icon;

// ─── Shared ArrowPath aliases ───────────────────────────────────────────────
export const Loader2 = ArrowPathIcon;
export const RotateCw = ArrowPathIcon;
export const RefreshCcw = ArrowPathIcon;

// ─── App-specific aliases (former lucide names) ─────────────────────────────
export const Home = HomeIcon;
export const Play = PlayIcon;
/** Workflows nav — Heroicons `command-line` */
export const Workflow = CommandLineIcon;
export const ClipboardCheck = ClipboardDocumentCheckIcon;
export const Globe = GlobeAltIcon;
export const FileSearch = DocumentMagnifyingGlassIcon;
/** Conversations nav / list — Heroicons `chat-bubble-left-right` */
export const MessageSquare = ChatBubbleLeftRightIcon;
export const Cog = Cog6ToothIcon;

/** Solid (24×24) — active / selected nav */
export const HomeSolid = HomeIconSolid;
export const PlaySolid = PlayIconSolid;
export const WorkflowSolid = CommandLineIconSolid;
export const ClipboardCheckSolid = ClipboardDocumentCheckIconSolid;
export const GlobeSolid = GlobeAltIconSolid;
export const FileSearchSolid = DocumentMagnifyingGlassIconSolid;
export const MessageSquareSolid = ChatBubbleLeftRightIconSolid;
export const CogSolid = Cog6ToothIconSolid;

export const ArrowUp = ArrowUpIcon;
export const Copy = DocumentDuplicateIcon;
export const Mic = MicrophoneIcon;
export const Paperclip = PaperClipIcon;
export const Pencil = PencilIcon;
export const Square = StopIcon;
export const ThumbsDown = HandThumbDownIcon;
export const ThumbsUp = HandThumbUpIcon;
export const X = XMarkIcon;

export const Check = CheckIcon;
export const Clock = ClockIcon;
export const ExternalLink = ArrowTopRightOnSquareIcon;
export const Hand = HandRaisedIcon;
export const Maximize2 = ArrowsPointingOutIcon;
export const Monitor = ComputerDesktopIcon;
export const CalendarClock = CalendarDaysIcon;
export const ChevronRight = ChevronRightIcon;
export const KeyRound = KeyIcon;
export const Pause = PauseIcon;
export const FileCheck2 = DocumentCheckIcon;
export const Lock = LockClosedIcon;
export const CheckCircle2 = CheckCircleIcon;
export const ShieldCheck = ShieldCheckIcon;
export const XCircle = XCircleIcon;

export const CircleCheckIcon = CheckCircleIcon;
export const InfoIcon = InformationCircleIcon;
export const TriangleAlertIcon = ExclamationTriangleIcon;
/** Close / error toasts (closest to lucide octagon-x). */
export const OctagonXIcon = XCircleIcon;

export const ArrowUpDown = ArrowsUpDownIcon;
export const Search = MagnifyingGlassIcon;
export const Brain = LightBulbIcon;
export const Eye = EyeIcon;
export const MousePointerClick = CursorArrowRippleIcon;
export const Wrench = WrenchIcon;

export const Building2 = BuildingOffice2Icon;
export const Code2 = CodeBracketIcon;
export const Plug = LinkIcon;
export const UserCog = UserCircleIcon;

export const CircleUser = UserCircleIcon;
export const CreditCard = CreditCardIcon;
export const EllipsisVertical = EllipsisVerticalIcon;
export const LogOut = ArrowRightStartOnRectangleIcon;
export const MessageSquareDot = ChatBubbleLeftEllipsisIcon;

export const PanelLeftIcon = Bars3Icon;
export const XIcon = XMarkIcon;

export const MoreHorizontalIcon = EllipsisHorizontalIcon;
export const Ellipsis = EllipsisHorizontalIcon;
export const Folder = FolderIcon;
export const Forward = ForwardIcon;
export const Trash2 = TrashIcon;

export const BadgeCheck = CheckBadgeIcon;
export const Bell = BellIcon;

// ─── Heroicons-native names (shadcn / UI parity) ───────────────────────────
export {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  MagnifyingGlassIcon as SearchIcon,
  MinusIcon,
};
