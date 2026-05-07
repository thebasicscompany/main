import Link from "next/link";

import { LoginForm } from "../../_components/login-form";
import { GoogleButton } from "../../_components/social-auth/google-button";

export const dynamic = "force-dynamic";

export default function LoginV2() {
  return (
    <div className="mx-auto flex w-full flex-col justify-center space-y-8 sm:w-[350px]">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-medium">Login to your account</h1>
        <p className="text-sm text-muted-foreground">Please enter your details to login.</p>
      </div>
      <div className="space-y-4">
        <GoogleButton className="w-full" />
        <div className="relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t after:border-border">
          <span className="relative z-10 bg-background px-2 text-muted-foreground">Or continue with</span>
        </div>
        <LoginForm />
        <p className="text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link prefetch={false} className="font-medium text-foreground hover:underline" href="/auth/v2/register">
            Register
          </Link>
        </p>
      </div>
    </div>
  );
}
