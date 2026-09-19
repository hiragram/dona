#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#if defined(__APPLE__)
#include <sys/sysctl.h>
#include <mach/mach_time.h>
#elif !defined(__linux__)
#error unsupported_clock_platform
#endif

static int boot_id(char out[37]) {
  char buffer[64] = {0}; size_t length = 0;
#if defined(__APPLE__)
  length = sizeof(buffer);
  if (sysctlbyname("kern.bootsessionuuid", buffer, &length, NULL, 0) != 0) return 0;
  if (length != 37 || buffer[36] != 0) return 0;
#else
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  if (fd < 0) return 0;
  ssize_t n = read(fd, buffer, sizeof(buffer));
  int closed = close(fd);
  if (n != 37 || closed != 0 || buffer[36] != '\n') return 0;
  length = (size_t)n;
#endif
  if (length != 37) return 0;
  for (size_t i=0; i<36; i++) {
    char c=buffer[i];
    if (i==8 || i==13 || i==18 || i==23) {if(c!='-')return 0;}
    else if (!((c>='0' && c<='9') || (c>='a' && c<='f') || (c>='A' && c<='F'))) return 0;
    out[i]=(c>='A' && c<='F') ? (char)(c-'A'+'a') : c;
  }
  out[36]=0; return 1;
}
static int continuous_millis(uint64_t *out) {
#if defined(__APPLE__)
  mach_timebase_info_data_t scale;
  if (mach_timebase_info(&scale)!=KERN_SUCCESS || scale.denom==0) return 0;
  __uint128_t n=(__uint128_t)mach_continuous_time()*scale.numer/scale.denom/1000000;
  if(n>UINT64_C(9007199254740991))return 0;
  *out=(uint64_t)n;
#else
  struct timespec ts;
  if(clock_gettime(CLOCK_BOOTTIME,&ts)!=0 || ts.tv_sec<0 || ts.tv_nsec<0 || ts.tv_nsec>=1000000000)return 0;
  __uint128_t n=(__uint128_t)ts.tv_sec*1000+(uint64_t)ts.tv_nsec/1000000;
  if(n>UINT64_C(9007199254740991))return 0;
  *out=(uint64_t)n;
#endif
  return 1;
}
int main(int argc, char **argv) {
  (void)argv;
  char before[37], after[37], stamp[32];uint64_t start,end;
  struct timespec wall;struct tm utc;
  if(argc!=1 || !boot_id(before) || !continuous_millis(&start)
    || clock_gettime(CLOCK_REALTIME,&wall)!=0 || !continuous_millis(&end) || !boot_id(after)
    || strcmp(before,after)!=0 || end<start || end-start>10 || wall.tv_sec<0
    || wall.tv_nsec<0 || wall.tv_nsec>=1000000000 || !gmtime_r(&wall.tv_sec,&utc)
    || strftime(stamp,sizeof(stamp),"%Y-%m-%dT%H:%M:%S",&utc)!=19) {
    fputs("clock_observation_unverified\n",stderr);return 1;
  }
  if(printf("{\"boot_id\":\"%s\",\"continuous_ms\":%" PRIu64 ",\"wall_utc\":\"%s.%03ldZ\"}\n",
    before,start,stamp,wall.tv_nsec/1000000)<0 || fflush(stdout)!=0)return 1;
  return 0;
}
