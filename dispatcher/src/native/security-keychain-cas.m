#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <math.h>
#import "security-keychain-cas.h"

// Provisioning is deliberately absent. Only a separately provisioned, entitled
// Data Protection Keychain item may be read or conditionally advanced.
static const unsigned long long maximumRevision = 9007199254740991ULL;
static const NSUInteger maximumValueBytes = 8192;

static BOOL keysEqual(NSDictionary *value, NSArray<NSString *> *keys) {
    return [value isKindOfClass:[NSDictionary class]] &&
        [[NSSet setWithArray:value.allKeys] isEqualToSet:[NSSet setWithArray:keys]];
}

static BOOL matches(id value, NSString *pattern, NSUInteger maximum) {
    if (![value isKindOfClass:[NSString class]] || [(NSString *)value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > maximum) return NO;
    NSRange match = [(NSString *)value rangeOfString:pattern options:NSRegularExpressionSearch];
    return match.location == 0 && match.length == [(NSString *)value length];
}

static BOOL revisionValue(id value, unsigned long long *result) {
    if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
    double number = [value doubleValue];
    if (!isfinite(number) || number < 1 || number > maximumRevision || floor(number) != number) return NO;
    *result = [value unsignedLongLongValue];
    return (double)*result == number;
}

static NSData *decodeValue(id value) {
    if (![value isKindOfClass:[NSString class]] || [(NSString *)value length] > 10924) return nil;
    NSData *bytes = [[NSData alloc] initWithBase64EncodedString:value options:0];
    if (bytes.length < 1 || bytes.length > maximumValueBytes || ![[bytes base64EncodedStringWithOptions:0] isEqual:value]) return nil;
    return bytes;
}

static NSString *account(unsigned long long revision) {
    return [NSString stringWithFormat:@"dona-cas-v1-%016llu", revision];
}

static NSDictionary *scope(id value) {
    if (!keysEqual(value, @[@"access_group", @"instance_id", @"purpose"])) return nil;
    if (!matches(value[@"access_group"], @"^[A-Z0-9]{10}\\.[A-Za-z0-9.-]+$", 256) ||
        !matches(value[@"instance_id"], @"^[A-Za-z0-9_-]{1,128}$", 128) ||
        ![@[@"audit_anchor", @"clock_mark", @"binding_generation", @"policy_generation"] containsObject:value[@"purpose"]]) return nil;
    return value;
}

static NSString *service(NSDictionary *identity) {
    return [NSString stringWithFormat:@"dev.dona.security.cas.v1.%@.%@", identity[@"purpose"], identity[@"instance_id"]];
}

static NSMutableDictionary *query(NSDictionary *identity) {
    LAContext *authentication = [LAContext new];
    authentication.interactionNotAllowed = YES;
    return [@{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service(identity),
        (__bridge id)kSecAttrAccessGroup: identity[@"access_group"],
        (__bridge id)kSecUseDataProtectionKeychain: @YES,
        (__bridge id)kSecUseAuthenticationContext: authentication,
    } mutableCopy];
}

static NSDictionary *readHead(NSDictionary *identity) {
    NSMutableDictionary *request = query(identity);
    // Inspect every match: a duplicate must never be mistaken for one head.
    request[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitAll;
    request[(__bridge id)kSecAttrSynchronizable] = (__bridge id)kSecAttrSynchronizableAny;
    request[(__bridge id)kSecReturnAttributes] = @YES;
    request[(__bridge id)kSecReturnData] = @YES;
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)request, &result);
    id rows = CFBridgingRelease(result);
    if (status != errSecSuccess || ![rows isKindOfClass:[NSArray class]] || [rows count] != 1) return nil;
    id row = rows[0];
    if (![row isKindOfClass:[NSDictionary class]]) return nil;
    id storedAccount = row[(__bridge id)kSecAttrAccount];
    id storedValue = row[(__bridge id)kSecValueData];
    id synchronized = row[(__bridge id)kSecAttrSynchronizable];
    if (!matches(storedAccount, @"^dona-cas-v1-[0-9]{16}$", 28) ||
        ![storedValue isKindOfClass:[NSData class]] || [storedValue length] < 1 || [storedValue length] > maximumValueBytes ||
        ![row[(__bridge id)kSecAttrService] isEqual:service(identity)] ||
        ![row[(__bridge id)kSecAttrAccessGroup] isEqual:identity[@"access_group"]] ||
        ![row[(__bridge id)kSecAttrAccessible] isEqual:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] ||
        ![synchronized isKindOfClass:[NSNumber class]] || [synchronized boolValue]) return nil;
    unsigned long long revision = 0;
    NSScanner *scanner = [NSScanner scannerWithString:[storedAccount substringFromIndex:12]];
    if (![scanner scanUnsignedLongLong:&revision] || !scanner.isAtEnd || revision < 1 || revision > maximumRevision ||
        ![storedAccount isEqual:account(revision)]) return nil;
    return @{@"revision": @(revision), @"value": [storedValue copy]};
}

static NSDictionary *handle(NSDictionary *request) {
    if (![request isKindOfClass:[NSDictionary class]] || ![request[@"codec_version"] isEqual:@1] ||
        CFGetTypeID((__bridge CFTypeRef)request[@"codec_version"]) == CFBooleanGetTypeID()) return nil;
    BOOL read = [request[@"operation"] isEqual:@"read"];
    BOOL cas = [request[@"operation"] isEqual:@"compare_exchange"];
    if ((!read && !cas) || !keysEqual(request, read ? @[@"codec_version", @"operation", @"scope"] :
        @[@"codec_version", @"operation", @"scope", @"expected_revision", @"expected_value", @"proposed_value"])) return nil;
    NSDictionary *identity = scope(request[@"scope"]);
    if (!identity) return nil;
    unsigned long long expectedRevision = 0;
    NSData *expected = nil, *proposed = nil;
    if (cas) {
        if (!revisionValue(request[@"expected_revision"], &expectedRevision) || expectedRevision == maximumRevision) return nil;
        expected = decodeValue(request[@"expected_value"]); proposed = decodeValue(request[@"proposed_value"]);
        if (!expected || !proposed) return nil;
    }
    NSDictionary *head = readHead(identity);
    if (!head) return nil;
    if (cas) {
        if ([head[@"revision"] unsignedLongLongValue] != expectedRevision || ![head[@"value"] isEqual:expected]) {
            return @{@"codec_version": @1, @"status": @"conflict"};
        }
        NSMutableDictionary *match = query(identity);
        match[(__bridge id)kSecAttrAccount] = account(expectedRevision);
        match[(__bridge id)kSecAttrSynchronizable] = @NO;
        match[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
        NSDictionary *update = @{
            (__bridge id)kSecAttrAccount: account(expectedRevision + 1),
            (__bridge id)kSecValueData: proposed,
        };
        // One update only. Every OS error and uncertain readback fails closed.
        if (SecItemUpdate((__bridge CFDictionaryRef)match, (__bridge CFDictionaryRef)update) != errSecSuccess) return nil;
        head = readHead(identity);
        if (!head || [head[@"revision"] unsignedLongLongValue] != expectedRevision + 1 || ![head[@"value"] isEqual:proposed]) return nil;
    }
    return @{@"codec_version": @1, @"status": read ? @"observed" : @"changed",
        @"revision": head[@"revision"], @"value": [head[@"value"] base64EncodedStringWithOptions:0]};
}

NSData *DonaKeychainCasProcessRequest(NSData *input) {
    @autoreleasepool {
        NSDictionary *response = nil;
        @try {
            if ([input isKindOfClass:[NSData class]] && input.length > 0 && input.length <= 32768) {
                NSData *bytes = [input copy];
                id request = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
                if ([request isKindOfClass:[NSDictionary class]]) {
                    NSData *canonical = [NSJSONSerialization dataWithJSONObject:request
                        options:NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes error:NULL];
                    if ([bytes isEqual:canonical]) response = handle(request);
                }
            }
        } @catch (NSException *exception) {
            (void)exception;
        }
        if (!response) response = @{@"codec_version": @1, @"status": @"unverified"};
        NSData *output = [NSJSONSerialization dataWithJSONObject:response
            options:NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes error:NULL];
        return output && output.length <= 16383 ? output : nil;
    }
}
