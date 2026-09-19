#import <Foundation/Foundation.h>
#import "../../../src/native/security-keychain-cas.h"
#include <stdio.h>

// Fixture-only frontend. Link with SecItem mock overrides, never with live
// Keychain operations. Production code has no main() or generic CAS endpoint.
int main(int argc, const char *argv[]) {
    (void)argv;
    @autoreleasepool {
        unsigned char buffer[32769];
        size_t length = argc == 1 ? fread(buffer, 1, sizeof(buffer), stdin) : 0;
        NSData *input = length > 0 && length <= 32768 && feof(stdin) && !ferror(stdin)
            ? [NSData dataWithBytes:buffer length:length] : [NSData data];
        NSData *output = DonaKeychainCasProcessRequest(input);
        if (!output || fwrite(output.bytes, 1, output.length, stdout) != output.length || fputc('\n', stdout) == EOF) return 1;
        NSDictionary *response = [NSJSONSerialization JSONObjectWithData:output options:0 error:NULL];
        return [response[@"status"] isEqual:@"unverified"] ? 1 : 0;
    }
}
